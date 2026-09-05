const assert = require("assert");
const {
  parseCells,
  sortCellsTextByCapacity,
  validatePackConfiguration,
  optimizePack,
  EXAMPLE_CELLS
} = require("./app.js");

function ids(result) {
  return result.groups.flatMap((group) => group.cells.map((cell) => cell.id));
}

function assertNoDuplicates(result) {
  const used = ids(result);
  assert.strictEqual(new Set(used).size, used.length, "nenhuma célula pode aparecer mais de uma vez");
}

function assertShape(result, series, parallel) {
  assert.strictEqual(result.groups.length, series, "quantidade de grupos");
  result.groups.forEach((group) => assert.strictEqual(group.cells.length, parallel, "células por grupo"));
  assert.strictEqual(result.usedCells.length, series * parallel, "total usado");
  assertNoDuplicates(result);
}

{
  const { cells } = parseCells("1000\n1500\n1200");
  const result = optimizePack(cells, 1, 1, "best");
  assertShape(result, 1, 1);
  assert.strictEqual(result.usedCells[0].id, "C2");
  assert.strictEqual(result.estimatedCapacity, 1500);
}

{
  const { cells } = parseCells("1000\n1500\n1200\n1300\n1100\n900\n800");
  const result = optimizePack(cells, 5, 1, "best");
  assertShape(result, 5, 1);
  assert.strictEqual(result.estimatedCapacity, Math.min(...result.groups.map((group) => group.capacity)));
}

{
  const { cells } = parseCells(EXAMPLE_CELLS);
  const result = optimizePack(cells, 5, 2, "best");
  assertShape(result, 5, 2);
}

{
  const { cells } = parseCells(EXAMPLE_CELLS);
  const result = optimizePack(cells, 4, 3, "best");
  assertShape(result, 4, 3);
}

{
  const { cells } = parseCells("100\n100\n100\n100\n100\n100\n100\n100\n99\n99\n99\n99");
  const best = optimizePack(cells, 2, 2, "best");
  assertShape(best, 2, 2);
  assert.strictEqual(best.range, 0);
}

{
  const { cells } = parseCells("110\n100\n100\n91\n90");
  const result = optimizePack(cells, 2, 2, "best");
  assertShape(result, 2, 2);
  assert.strictEqual(result.range, 0, "uma célula ligeiramente menor deve poder melhorar o balanceamento");
  assert(ids(result).includes("C5"), "a célula menor C5 deve substituir a C4 neste cenário");
}

{
  const { cells } = parseCells("1000\n1000\n1000\n1000\n1000\n1000");
  const result = optimizePack(cells, 3, 2, "best");
  assertShape(result, 3, 2);
  assert.strictEqual(result.range, 0);
  assert.strictEqual(result.standardDeviation, 0);
}

{
  const { cells } = parseCells("1000\n1000\n1000\n1000\n1000\n1000\n1000\n1000\n1000");
  const validation = validatePackConfiguration(cells, 5, 2);
  assert.strictEqual(validation.valid, false);
}

{
  const { cells } = parseCells("1218\n1195\n1203\n1178\n1221\n1160\n1209\n1188\n1230\n1211\n1155\n1198\n1205\n1172\n1224");
  const result = optimizePack(cells, 5, 2, "best");
  assertShape(result, 5, 2);
}

{
  const parsed = parseCells("1187,5 mAh\n1210; 1195\n1200,25");
  assert.deepStrictEqual(parsed.cells.map((cell) => cell.capacity), [1187.5, 1210, 1195, 1200.25]);
}

{
  const sorted = sortCellsTextByCapacity("1187,5 mAh\n1210; 1195\n1200,25");
  assert.strictEqual(sorted.text, "1210\n1200,25\n1195\n1187,5");
  const reparsed = parseCells(sorted.text);
  assert.deepStrictEqual(reparsed.cells.map((cell) => cell.capacity), [1210, 1200.25, 1195, 1187.5]);
}

console.log("Todos os testes passaram.");
