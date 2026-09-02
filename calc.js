/* Физика полки стеллажа — перенос из движка (calc/stellazh.py) один в один.
   Числа обязаны совпадать с питоновскими: расхождение означает ошибку переноса,
   и внизу файла лежит самопроверка, которая падает в консоль при расхождении. */

const E_STEEL = 2.0e5;          // МПа
const G_ACC = 9.80665;
const RHO_STEEL = 7.85e-6;      // кг/мм³
const YIELD = { '08пс': 195.0, 'Ст3': 245.0 };
const SAFETY_STRENGTH = 1.25;   // ГОСТ Р 55525-2017
const DEFLECTION_RATIO = 200;   // прогиб не более L/200

/* Доля сжатой полки, которая реально работает (формула Винтера, EN 1993-1-5).
   Без неё балочная модель завышает тонкую широкую полку в разы. */
function effectiveWidthRatio(b, t, fy, kSigma = 4.0, psi = 1.0) {
  if (b <= 0 || t <= 0) return 1.0;
  const eps = Math.sqrt(235.0 / fy);
  const lam = (b / t) / (28.4 * eps * Math.sqrt(kSigma));
  if (lam <= 0.673) return 1.0;
  return Math.min(1.0, (lam - 0.055 * (3 + psi)) / (lam * lam));
}

/* Сечение полки-лотка поперёк пролёта: лист глубиной depth с бортами вниз,
   lip — двойной подгиб на конце борта внутрь. */
function traySection(depth, t, bort, fy, ribs = 0, lip = 0) {
  const rho = effectiveWidthRatio(depth / (ribs + 1), t, fy);
  const bEff = rho * depth;
  const web = bort - t;
  const parts = [[bEff * t, t / 2], [2 * web * t, t + web / 2]];
  if (lip > 0) parts.push([2 * lip * t, bort - t / 2]);
  const area = parts.reduce((s, p) => s + p[0], 0);
  const yc = parts.reduce((s, p) => s + p[0] * p[1], 0) / area;
  let I = bEff * Math.pow(t, 3) / 12 + (bEff * t) * Math.pow(yc - t / 2, 2);
  I += 2 * (t * Math.pow(web, 3) / 12 + (web * t) * Math.pow(t + web / 2 - yc, 2));
  if (lip > 0) I += 2 * (lip * Math.pow(t, 3) / 12 + (lip * t) * Math.pow(bort - t / 2 - yc, 2));
  const wTop = I / Math.max(yc, 1e-9);
  const wBot = I / Math.max(bort - yc, 1e-9);
  return { area, I, W: Math.min(wTop, wBot), yc, working: bEff };
}

/* Проходит ли полка заданную нагрузку: прочность и прогиб по ГОСТ. */
function checkShelf(loadKg, span, depth, t, bort, grade = '08пс', ribs = 0, lip = 0) {
  const fy = YIELD[grade];
  const s = traySection(depth, t, bort, fy, ribs, lip);
  const q = loadKg * G_ACC / span;
  const sigma = q * span * span / 8.0 / s.W;
  const defl = 5 * q * Math.pow(span, 4) / (384 * E_STEEL * s.I);
  const limSigma = fy / SAFETY_STRENGTH;
  const limDefl = span / DEFLECTION_RATIO;
  return {
    ok: sigma <= limSigma && defl <= limDefl,
    sigma, limSigma, defl, limDefl,
    working: s.working,
    marginSigma: limSigma / sigma,
    marginDefl: limDefl / defl,
  };
}

/* Сколько полка держит на самом деле. */
function maxLoadKg(span, depth, t, bort, grade = '08пс', ribs = 0, lip = 0, ceiling = 600) {
  let lo = 0, hi = ceiling;
  if (checkShelf(hi, span, depth, t, bort, grade, ribs, lip).ok) return hi;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (checkShelf(mid, span, depth, t, bort, grade, ribs, lip).ok) lo = mid; else hi = mid;
  }
  return Math.floor(lo);
}

/* ── Экономика пункта выдачи ─────────────────────────────────────────────── */

const TARIFF = { ret: 15.0, move: 5.0, prep: 5.0, placeLDay: 0.2 };  // ₽, тарифы Ozon
const BOX = { l: 400, w: 280, h: 340 };                              // мм, коробка ячейки
const DAYS = 30;

function boxesPerRack(widthCm, levels) {
  const perRow = widthCm >= 120 ? 4 : 3;
  return perRow * levels;
}

function rackCapacityL(widthCm, levels) {
  return boxesPerRack(widthCm, levels) * BOX.l * BOX.w * BOX.h / 1e6;
}

/* Доход пункта с парка стеллажей. Размещение зависит ТОЛЬКО от ёмкости и
   заполнения, операции — ТОЛЬКО от потока. Это разные рычаги. */
function pvzIncome({ racks, widthCm, levels, fill, returnsPerMonth }) {
  const capacity = rackCapacityL(widthCm, levels) * racks;
  const placement = capacity * fill * TARIFF.placeLDay * DAYS;
  const operations = returnsPerMonth * (TARIFF.ret + TARIFF.move + TARIFF.prep);
  return {
    capacity,
    boxes: boxesPerRack(widthCm, levels) * racks,
    placement, operations,
    total: placement + operations,
    ceiling: capacity * TARIFF.placeLDay * DAYS,
  };
}

/* Сколько стеллажей встанет на свободное место.

   Считаем не по всей площади ПВЗ: там уже стоят стеллажи под посылки, стол
   выдачи и примерочная, а стеллажи для товаров продавцов Ozon требует ставить
   ОТДЕЛЬНО. Поэтому спрашиваем именно свободное место и кладём на стеллаж его
   габарит плюс подход к полкам — около 1,2 м² при ширине 120 см. */
function racksFit(freeM2, widthCm) {
  const perRack = (widthCm / 100) * 0.4 + 0.72;   // сам стеллаж плюс подход
  return Math.max(0, Math.floor(freeM2 / perRack));
}

/* ── Самопроверка: числа обязаны совпасть с движком ──────────────────────── */
(function selfTest() {
  const cases = [
    // [span, depth, t, bort, grade, ribs, lip, ожидание из Python]
    [1160, 400, 0.6, 50, '08пс', 0, 15, 154],
    [1160, 400, 0.6, 50, '08пс', 0, 10, 128],
    [1160, 400, 0.6, 30, '08пс', 0, 0, 29],
    [1160, 400, 0.6, 40, '08пс', 0, 15, 114],
    [960, 400, 0.6, 50, '08пс', 0, 10, 155],
  ];
  const bad = [];
  for (const [span, depth, t, bort, grade, ribs, lip, want] of cases) {
    const got = maxLoadKg(span, depth, t, bort, grade, ribs, lip);
    if (Math.abs(got - want) > 1) bad.push(`${bort}/${lip}: ожидали ${want}, вышло ${got}`);
  }
  if (bad.length) console.error('РАСХОЖДЕНИЕ С ДВИЖКОМ:', bad);
  else console.info('физика сходится с движком: ' + cases.length + ' контрольных точек');
})();
