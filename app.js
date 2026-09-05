(function () {
  "use strict";

  const CAPACITY_TOLERANCE_MAH = 1;
  const EXACT_PARTITION_CELL_LIMIT = 16;
  const MAX_REPLACEMENT_PASSES = 4;
  const QUALITY_LIMITS = [
    { max: 0.5, label: "Excelente", className: "excellent" },
    { max: 1, label: "Muito bom", className: "very-good" },
    { max: 2, label: "Bom", className: "good" },
    { max: 5, label: "Aceitável", className: "acceptable" },
    { max: Infinity, label: "Ruim", className: "poor" }
  ];
  const STORAGE_KEY = "battery-pack-calculator-state-v1";
  const EXAMPLE_CELLS = `1218
1195
1203
1178
1221
1160
1209
1188
1230
1211
1155
1198
1205
1172
1224
1184
1216
1169
1201
1192
1228
1175
1213
1180
1207
1158
1220
1190
1204
1176`;

  const state = {
    lastResult: null,
    cells: [],
    sort: { key: "id", direction: "asc" }
  };

  function parseCells(text) {
    const cells = [];
    const invalid = [];
    const tokens = [];
    const lines = String(text || "").split(/\r?\n/);

    lines.forEach(function (line, lineIndex) {
      const trimmed = line.trim();
      if (!trimmed) return;
      const hasHardSeparator = /[;\t ]/.test(trimmed) || /,\s+/.test(trimmed);
      const decimalCommaOnly = /^[-+]?\d+,\d{1,3}(?:\s*mAh)?$/i.test(trimmed);
      const prepared = !hasHardSeparator && decimalCommaOnly
        ? trimmed.replace(",", ".")
        : trimmed.replace(/(\d),(\d{1,3})(?=\s*mAh\b|$)/gi, "$1.$2");
      const parts = prepared
        .replace(/mAh/gi, " ")
        .split(/[;\s,]+/)
        .map(function (part) { return part.trim(); })
        .filter(Boolean);

      if (!parts.length) {
        invalid.push({ line: lineIndex + 1, value: line });
      }
      parts.forEach(function (part) {
        tokens.push({ line: lineIndex + 1, value: part });
      });
    });

    tokens.forEach(function (token) {
      if (!/^[+-]?\d+(?:\.\d+)?$/.test(token.value)) {
        invalid.push(token);
        return;
      }
      const capacity = Number(token.value);
      if (!Number.isFinite(capacity) || capacity <= 0) {
        invalid.push(token);
        return;
      }
      cells.push({ id: "C" + (cells.length + 1), capacity: capacity });
    });

    return { cells: cells, invalid: invalid };
  }

  function sortCellsTextByCapacity(text) {
    const parsed = parseCells(text);
    if (parsed.invalid.length) return { text: text, parsed: parsed, changed: false };
    const sorted = sortCellsByCapacity(parsed.cells);
    return {
      text: sorted.map(function (cell) { return formatInputCapacity(cell.capacity); }).join("\n"),
      parsed: parsed,
      changed: true
    };
  }

  function formatInputCapacity(value) {
    if (Number.isInteger(value)) return String(value);
    return String(value).replace(".", ",");
  }

  function validatePackConfiguration(cells, series, parallel) {
    const errors = [];
    if (!cells.length) errors.push("Informe ao menos uma célula válida.");
    if (!Number.isInteger(series) || series <= 0) errors.push("S deve ser um inteiro maior que zero.");
    if (!Number.isInteger(parallel) || parallel <= 0) errors.push("P deve ser um inteiro maior que zero.");
    const needed = series * parallel;
    if (Number.isInteger(series) && Number.isInteger(parallel) && cells.length < needed) {
      errors.push("São necessárias " + needed + " células para um pack " + series + "S" + parallel + "P, mas apenas " + cells.length + " foram fornecidas.");
    }
    return { valid: errors.length === 0, errors: errors, needed: needed };
  }

  function optimizePack(cells, series, parallel, mode) {
    const start = performanceNow();
    const needed = series * parallel;
    const sorted = sortCellsByCapacity(cells);
    const baseSelected = sorted.slice(0, needed);
    const stats = { attempts: 0, replacements: 0, strategy: "" };
    let best = buildSolution(baseSelected, cells, series, parallel, stats);
    stats.strategy = "ordenações gulosas, particionamento exato quando viável e melhoria local";

    if (mode !== "highest") {
      const candidateSets = createCandidateSets(sorted, needed, series, parallel);
      candidateSets.forEach(function (set) {
        const solution = buildSolution(set, cells, series, parallel, stats);
        if (compareSolutions(solution, best) > 0) best = solution;
      });
      best = improveSolution(best, cells, series, parallel, stats);
    }

    best.elapsedMs = performanceNow() - start;
    best.attempts = stats.attempts;
    best.replacements = stats.replacements;
    best.strategy = stats.strategy;
    best.scoreText = "min " + formatNumber(best.minCapacity) + " / range " + formatNumber(best.range) + " / DP " + formatNumber(best.standardDeviation);
    return best;
  }

  function createCandidateSets(sorted, needed, series, parallel) {
    const sets = [];
    const seen = new Set();
    const windowSize = Math.min(sorted.length, Math.max(needed + 16, needed + series * 3, needed));
    const windowCells = sorted.slice(0, windowSize);

    function addSet(items) {
      const selected = items.slice(0, needed);
      if (selected.length !== needed) return;
      const key = selected.map(function (cell) { return cell.id; }).sort(naturalIdSort).join("|");
      if (!seen.has(key)) {
        seen.add(key);
        sets.push(selected);
      }
    }

    addSet(sorted.slice(0, needed));
    for (let offset = 1; offset <= Math.min(12, sorted.length - needed); offset += 1) {
      addSet(sorted.slice(0, needed - 1).concat(sorted[needed - 1 + offset]));
    }
    for (let keep = needed - 2; keep >= Math.max(1, needed - 8); keep -= 1) {
      addSet(sorted.slice(0, keep).concat(sorted.slice(needed, needed + (needed - keep))));
    }

    if (parallel === 2) {
      addSet(createPairBalancedSeed(windowCells, series));
    }

    addSet(interleaveHighLow(windowCells).slice(0, needed));
    return sets;
  }

  function createPairBalancedSeed(cells, series) {
    const selected = [];
    let left = 0;
    let right = Math.min(cells.length - 1, series * 4 - 1);
    while (selected.length < series * 2 && left <= right) {
      selected.push(cells[left]);
      if (selected.length < series * 2 && right !== left) selected.push(cells[right]);
      left += 1;
      right -= 1;
    }
    return selected;
  }

  function interleaveHighLow(cells) {
    const result = [];
    let left = 0;
    let right = cells.length - 1;
    while (left <= right) {
      result.push(cells[left]);
      if (left !== right) result.push(cells[right]);
      left += 1;
      right -= 1;
    }
    return result;
  }

  function improveSolution(initial, allCells, series, parallel, stats) {
    let best = initial;
    for (let pass = 0; pass < MAX_REPLACEMENT_PASSES; pass += 1) {
      let improved = false;
      const usedIds = new Set(best.usedCells.map(function (cell) { return cell.id; }));
      const unused = sortCellsByCapacity(allCells.filter(function (cell) { return !usedIds.has(cell.id); }));
      const used = best.usedCells.slice().sort(function (a, b) {
        return a.capacity - b.capacity || naturalIdSort(a.id, b.id);
      });

      for (let u = 0; u < unused.length; u += 1) {
        for (let r = 0; r < used.length; r += 1) {
          if (unused[u].capacity < used[r].capacity - Math.max(CAPACITY_TOLERANCE_MAH, best.range + 2)) continue;
          const candidateCells = best.usedCells
            .filter(function (cell) { return cell.id !== used[r].id; })
            .concat(unused[u]);
          const candidate = buildSolution(candidateCells, allCells, series, parallel, stats);
          stats.replacements += 1;
          if (compareSolutions(candidate, best) > 0) {
            best = candidate;
            improved = true;
            break;
          }
        }
        if (improved) break;
      }
      if (!improved) break;
    }
    return best;
  }

  function buildSolution(selectedCells, allCells, series, parallel, stats) {
    const partition = balanceGroups(selectedCells, series, parallel, stats);
    return finalizeSolution(partition, allCells, series, parallel);
  }

  function balanceGroups(cells, series, parallel, stats) {
    const selected = cells.slice();
    let best = null;
    const orderings = [
      sortCellsByCapacity(selected),
      sortCellsByCapacity(selected).reverse(),
      interleaveHighLow(sortCellsByCapacity(selected)),
      sortCellsByCapacity(selected).sort(function (a, b) {
        return (a.capacity % 10) - (b.capacity % 10) || b.capacity - a.capacity || naturalIdSort(a.id, b.id);
      })
    ];

    orderings.forEach(function (ordering) {
      const greedy = greedyPartition(ordering, series, parallel);
      const improved = improveGroupSwaps(greedy, parallel, stats);
      if (!best || compareEvaluations(evaluateGroups(improved), evaluateGroups(best)) > 0) {
        best = cloneGroups(improved);
      }
      stats.attempts += 1;
    });

    if (selected.length <= EXACT_PARTITION_CELL_LIMIT) {
      const exact = exactPartition(selected, series, parallel, stats, best);
      if (exact && compareEvaluations(evaluateGroups(exact), evaluateGroups(best)) > 0) best = exact;
    }

    return best.map(function (group, index) {
      return {
        index: index + 1,
        cells: group.cells.slice().sort(function (a, b) { return b.capacity - a.capacity || naturalIdSort(a.id, b.id); }),
        capacity: group.capacity
      };
    });
  }

  function greedyPartition(ordering, series, parallel) {
    const groups = Array.from({ length: series }, function (_, index) {
      return { index: index + 1, cells: [], capacity: 0 };
    });
    ordering.forEach(function (cell) {
      groups.sort(function (a, b) {
        if (a.cells.length === parallel) return 1;
        if (b.cells.length === parallel) return -1;
        return a.capacity - b.capacity || a.cells.length - b.cells.length || a.index - b.index;
      });
      groups[0].cells.push(cell);
      groups[0].capacity += cell.capacity;
    });
    return groups.sort(function (a, b) { return a.index - b.index; });
  }

  function improveGroupSwaps(groups, parallel, stats) {
    let current = cloneGroups(groups);
    let improved = true;
    let guard = 0;
    while (improved && guard < 200) {
      improved = false;
      guard += 1;
      for (let i = 0; i < current.length; i += 1) {
        for (let j = i + 1; j < current.length; j += 1) {
          for (let a = 0; a < current[i].cells.length; a += 1) {
            for (let b = 0; b < current[j].cells.length; b += 1) {
              const candidate = cloneGroups(current);
              const cellA = candidate[i].cells[a];
              const cellB = candidate[j].cells[b];
              candidate[i].cells[a] = cellB;
              candidate[j].cells[b] = cellA;
              recomputeGroup(candidate[i]);
              recomputeGroup(candidate[j]);
              stats.attempts += 1;
              if (candidate[i].cells.length === parallel && candidate[j].cells.length === parallel &&
                compareEvaluations(evaluateGroups(candidate), evaluateGroups(current)) > 0) {
                current = candidate;
                improved = true;
              }
            }
          }
        }
      }
    }
    return current;
  }

  function exactPartition(cells, series, parallel, stats, seedGroups) {
    const ordered = sortCellsByCapacity(cells);
    const groups = Array.from({ length: series }, function (_, index) {
      return { index: index + 1, cells: [], capacity: 0 };
    });
    let best = cloneGroups(seedGroups);
    let bestEval = evaluateGroups(best);

    function search(position) {
      if (position === ordered.length) {
        if (groups.every(function (group) { return group.cells.length === parallel; })) {
          const candidate = cloneGroups(groups);
          const candidateEval = evaluateGroups(candidate);
          stats.attempts += 1;
          if (compareEvaluations(candidateEval, bestEval) > 0) {
            best = candidate;
            bestEval = candidateEval;
          }
        }
        return;
      }

      const cell = ordered[position];
      const seenLoads = new Set();
      for (let i = 0; i < groups.length; i += 1) {
        if (groups[i].cells.length >= parallel) continue;
        const symmetryKey = groups[i].capacity + ":" + groups[i].cells.length;
        if (seenLoads.has(symmetryKey)) continue;
        seenLoads.add(symmetryKey);
        groups[i].cells.push(cell);
        groups[i].capacity += cell.capacity;
        search(position + 1);
        groups[i].capacity -= cell.capacity;
        groups[i].cells.pop();
      }
    }

    search(0);
    return best;
  }

  function finalizeSolution(groups, allCells, series, parallel) {
    const groupMap = new Map();
    const usedCells = [];
    groups.forEach(function (group) {
      group.cells.forEach(function (cell) {
        groupMap.set(cell.id, "S" + group.index);
        usedCells.push(cell);
      });
    });
    const unusedCells = allCells.filter(function (cell) { return !groupMap.has(cell.id); })
      .sort(function (a, b) { return b.capacity - a.capacity || naturalIdSort(a.id, b.id); });
    const stats = calculateStatistics(groups);
    return Object.assign({
      groups: groups,
      usedCells: usedCells,
      unusedCells: unusedCells,
      cellGroupMap: groupMap,
      series: series,
      parallel: parallel
    }, stats);
  }

  function evaluateSolution(solution) {
    return {
      minCapacity: solution.minCapacity,
      range: solution.range,
      standardDeviation: solution.standardDeviation,
      totalCapacity: solution.totalCapacity
    };
  }

  function evaluateGroups(groups) {
    return calculateStatistics(groups);
  }

  function calculateStatistics(groups) {
    const capacities = groups.map(function (group) { return group.capacity; });
    const totalCapacity = capacities.reduce(function (sum, value) { return sum + value; }, 0);
    const minCapacity = Math.min.apply(null, capacities);
    const maxCapacity = Math.max.apply(null, capacities);
    const averageCapacity = totalCapacity / capacities.length;
    const variance = capacities.reduce(function (sum, value) {
      return sum + Math.pow(value - averageCapacity, 2);
    }, 0) / capacities.length;
    const range = maxCapacity - minCapacity;
    return {
      minCapacity: minCapacity,
      maxCapacity: maxCapacity,
      averageCapacity: averageCapacity,
      range: range,
      imbalancePercent: minCapacity > 0 ? (range / minCapacity) * 100 : 0,
      standardDeviation: Math.sqrt(variance),
      totalCapacity: totalCapacity,
      estimatedCapacity: minCapacity
    };
  }

  function compareSolutions(a, b) {
    return compareEvaluations(evaluateSolution(a), evaluateSolution(b));
  }

  function compareEvaluations(a, b) {
    const minDiff = a.minCapacity - b.minCapacity;
    if (Math.abs(minDiff) > CAPACITY_TOLERANCE_MAH) return minDiff > 0 ? 1 : -1;
    if (Math.abs(a.range - b.range) > 1e-9) return a.range < b.range ? 1 : -1;
    if (Math.abs(a.standardDeviation - b.standardDeviation) > 1e-9) return a.standardDeviation < b.standardDeviation ? 1 : -1;
    if (Math.abs(minDiff) > 1e-9) return minDiff > 0 ? 1 : -1;
    if (Math.abs(a.totalCapacity - b.totalCapacity) > 1e-9) return a.totalCapacity > b.totalCapacity ? 1 : -1;
    return 0;
  }

  function sortCellsByCapacity(cells) {
    return cells.slice().sort(function (a, b) {
      return b.capacity - a.capacity || naturalIdSort(a.id, b.id);
    });
  }

  function naturalIdSort(a, b) {
    return Number(String(a).replace(/\D/g, "")) - Number(String(b).replace(/\D/g, ""));
  }

  function cloneGroups(groups) {
    return groups.map(function (group, index) {
      return { index: group.index || index + 1, cells: group.cells.slice(), capacity: group.capacity };
    });
  }

  function recomputeGroup(group) {
    group.capacity = group.cells.reduce(function (sum, cell) { return sum + cell.capacity; }, 0);
  }

  function formatNumber(value, digits) {
    const maximumFractionDigits = digits == null ? 2 : digits;
    return Number(value).toLocaleString("pt-BR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: maximumFractionDigits
    });
  }

  function performanceNow() {
    if (typeof performance !== "undefined" && performance.now) return performance.now();
    return Date.now();
  }

  function getQuality(imbalancePercent) {
    return QUALITY_LIMITS.find(function (limit) { return imbalancePercent <= limit.max; });
  }

  function initializeUi() {
    const dom = {
      cellInput: document.getElementById("cellInput"),
      sortBeforeOptimizeInput: document.getElementById("sortBeforeOptimizeInput"),
      seriesInput: document.getElementById("seriesInput"),
      parallelInput: document.getElementById("parallelInput"),
      neededCount: document.getElementById("neededCount"),
      availableCount: document.getElementById("availableCount"),
      usedCount: document.getElementById("usedCount"),
      unusedCount: document.getElementById("unusedCount"),
      optimizeBtn: document.getElementById("optimizeBtn"),
      loadExampleBtn: document.getElementById("loadExampleBtn"),
      clearBtn: document.getElementById("clearBtn"),
      message: document.getElementById("message"),
      emptyState: document.getElementById("emptyState"),
      resultPanel: document.getElementById("resultPanel"),
      unusedPanel: document.getElementById("unusedPanel"),
      tablePanel: document.getElementById("tablePanel"),
      packTitle: document.getElementById("packTitle"),
      qualityText: document.getElementById("qualityText"),
      qualityBadge: document.getElementById("qualityBadge"),
      summaryGrid: document.getElementById("summaryGrid"),
      seriesExplanation: document.getElementById("seriesExplanation"),
      usedCellsList: document.getElementById("usedCellsList"),
      groupsContainer: document.getElementById("groupsContainer"),
      barsContainer: document.getElementById("barsContainer"),
      technicalDetails: document.getElementById("technicalDetails"),
      unusedCells: document.getElementById("unusedCells"),
      cellTableBody: document.getElementById("cellTableBody"),
      themeToggle: document.getElementById("themeToggle")
    };

    loadState(dom);
    refreshCounts(dom);

    ["input", "change"].forEach(function (eventName) {
      dom.cellInput.addEventListener(eventName, function () { refreshCounts(dom); saveState(dom); });
      dom.seriesInput.addEventListener(eventName, function () { refreshCounts(dom); saveState(dom); });
      dom.parallelInput.addEventListener(eventName, function () { refreshCounts(dom); saveState(dom); });
    });

    dom.sortBeforeOptimizeInput.addEventListener("change", function () { saveState(dom); });

    document.querySelectorAll("[data-series]").forEach(function (button) {
      button.addEventListener("click", function () {
        dom.seriesInput.value = button.dataset.series;
        refreshCounts(dom);
        saveState(dom);
      });
    });

    document.querySelectorAll("input[name='selectionMode']").forEach(function (radio) {
      radio.addEventListener("change", function () { saveState(dom); });
    });

    dom.optimizeBtn.addEventListener("click", function () { runOptimization(dom); });
    dom.loadExampleBtn.addEventListener("click", function () {
      dom.cellInput.value = EXAMPLE_CELLS;
      dom.seriesInput.value = 5;
      dom.parallelInput.value = 2;
      dom.sortBeforeOptimizeInput.checked = true;
      document.querySelector("input[name='selectionMode'][value='best']").checked = true;
      refreshCounts(dom);
      saveState(dom);
    });
    dom.clearBtn.addEventListener("click", function () {
      if (!confirm("Apagar a lista, configuração e último resultado?")) return;
      localStorage.removeItem(STORAGE_KEY);
      dom.cellInput.value = "";
      dom.seriesInput.value = 5;
      dom.parallelInput.value = 2;
      dom.sortBeforeOptimizeInput.checked = true;
      document.querySelector("input[name='selectionMode'][value='best']").checked = true;
      state.lastResult = null;
      renderEmpty(dom);
      refreshCounts(dom);
    });
    dom.themeToggle.addEventListener("click", function () {
      const current = document.documentElement.dataset.theme || "";
      document.documentElement.dataset.theme = current === "dark" ? "light" : "dark";
      saveState(dom);
    });
    document.querySelectorAll("[data-sort]").forEach(function (button) {
      button.addEventListener("click", function () {
        const key = button.dataset.sort;
        state.sort.direction = state.sort.key === key && state.sort.direction === "asc" ? "desc" : "asc";
        state.sort.key = key;
        renderCellTable(dom, state.cells, state.lastResult);
        saveState(dom);
      });
    });
  }

  function runOptimization(dom) {
    let parsed = parseCells(dom.cellInput.value);
    const series = Number(dom.seriesInput.value);
    const parallel = Number(dom.parallelInput.value);

    state.cells = parsed.cells;
    if (parsed.invalid.length) {
      setMessage(dom, "Valores inválidos encontrados. Revise: " + parsed.invalid.slice(0, 4).map(function (item) { return item.value; }).join(", "), false);
      renderEmpty(dom);
      return;
    }

    if (dom.sortBeforeOptimizeInput.checked) {
      const sortedInput = sortCellsTextByCapacity(dom.cellInput.value);
      dom.cellInput.value = sortedInput.text;
      parsed = parseCells(dom.cellInput.value);
      state.cells = parsed.cells;
      refreshCounts(dom);
    }

    const validation = validatePackConfiguration(parsed.cells, series, parallel);
    if (!validation.valid) {
      setMessage(dom, validation.errors.join(" "), false);
      renderEmpty(dom);
      return;
    }

    setMessage(dom, "Otimizando...", true);
    setTimeout(function () {
      const mode = document.querySelector("input[name='selectionMode']:checked").value;
      const result = optimizePack(parsed.cells, series, parallel, mode);
      state.lastResult = result;
      renderResult(dom, parsed.cells, result);
      refreshCounts(dom);
      saveState(dom);
      setMessage(dom, "Pack otimizado.", true);
    }, 20);
  }

  function refreshCounts(dom) {
    const parsed = parseCells(dom.cellInput.value);
    const series = Math.max(0, Number(dom.seriesInput.value) || 0);
    const parallel = Math.max(0, Number(dom.parallelInput.value) || 0);
    const needed = series * parallel;
    const used = state.lastResult ? state.lastResult.usedCells.length : 0;
    dom.neededCount.textContent = needed;
    dom.availableCount.textContent = parsed.cells.length;
    dom.usedCount.textContent = used;
    dom.unusedCount.textContent = Math.max(0, parsed.cells.length - used);
  }

  function renderResult(dom, cells, result) {
    state.cells = cells;
    dom.emptyState.classList.add("hidden");
    dom.resultPanel.classList.remove("hidden");
    dom.unusedPanel.classList.remove("hidden");
    dom.tablePanel.classList.remove("hidden");
    dom.packTitle.textContent = "Pack " + result.series + "S" + result.parallel + "P";
    const quality = getQuality(result.imbalancePercent);
    dom.qualityText.textContent = "Classificação por desequilíbrio";
    dom.qualityBadge.textContent = quality.label;
    dom.qualityBadge.className = "quality-badge " + quality.className;
    renderSummary(dom, result);
    renderUsedCells(dom, result);
    renderGroups(dom, result);
    renderBars(dom, result);
    renderUnusedCells(dom, result);
    renderTechnicalDetails(dom, result);
    renderCellTable(dom, cells, result);
  }

  function renderUsedCells(dom, result) {
    const sortedUsed = sortCellsByCapacity(result.usedCells);
    dom.seriesExplanation.textContent = "Em " + result.series + "S" + result.parallel + "P existem " + result.series + " grupos em série, chamados S1 a S" + result.series + ". Cada grupo recebe exatamente " + result.parallel + " célula(s) em paralelo. Use fisicamente as células abaixo e monte cada uma no grupo indicado em seguida.";
    dom.usedCellsList.innerHTML = sortedUsed.map(function (cell) {
      return '<div class="unused-cell"><span>' + escapeHtml(cell.id) + ' → ' + escapeHtml(result.cellGroupMap.get(cell.id)) + '</span><strong>' + formatNumber(cell.capacity) + ' mAh</strong></div>';
    }).join("");
  }

  function renderSummary(dom, result) {
    const items = [
      ["Configuração", result.series + "S" + result.parallel + "P"],
      ["Células utilizadas", result.usedCells.length + " / " + (result.usedCells.length + result.unusedCells.length)],
      ["Capacidade estimada", formatNumber(result.estimatedCapacity) + " mAh"],
      ["Grupo mínimo", formatNumber(result.minCapacity) + " mAh"],
      ["Grupo máximo", formatNumber(result.maxCapacity) + " mAh"],
      ["Diferença máxima", formatNumber(result.range) + " mAh"],
      ["Desequilíbrio", formatNumber(result.imbalancePercent, 3) + "%"],
      ["Média dos grupos", formatNumber(result.averageCapacity) + " mAh"],
      ["Desvio padrão", formatNumber(result.standardDeviation, 3)],
      ["Soma utilizada", formatNumber(result.totalCapacity) + " mAh"]
    ];
    dom.summaryGrid.innerHTML = items.map(function (item) {
      return '<div class="summary-item"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong></div>';
    }).join("");
  }

  function renderGroups(dom, result) {
    dom.groupsContainer.innerHTML = result.groups.map(function (group) {
      const roleClass = group.capacity === result.minCapacity ? " min" : group.capacity === result.maxCapacity ? " max" : "";
      return '<article class="group-card' + roleClass + '">' +
        '<h4><span>S' + group.index + ' - grupo em série ' + group.index + '</span><span>' + formatNumber(group.capacity) + ' mAh</span></h4>' +
        group.cells.map(function (cell) {
          return '<div class="cell-row"><span>' + escapeHtml(cell.id) + '</span><strong>' + formatNumber(cell.capacity) + ' mAh</strong></div>';
        }).join("") +
        '<div class="total">Total: ' + formatNumber(group.capacity) + ' mAh</div>' +
      '</article>';
    }).join("");
  }

  function renderBars(dom, result) {
    dom.barsContainer.innerHTML = result.groups.map(function (group) {
      const width = result.maxCapacity ? Math.max(4, (group.capacity / result.maxCapacity) * 100) : 0;
      const roleClass = group.capacity === result.minCapacity ? " min" : group.capacity === result.maxCapacity ? " max" : "";
      return '<div class="bar-row' + roleClass + '">' +
        '<span>S' + group.index + '</span>' +
        '<div class="bar-track"><div class="bar-fill" style="--bar-width:' + width.toFixed(4) + '%"></div></div>' +
        '<strong>' + formatNumber(group.capacity) + ' mAh</strong>' +
      '</div>';
    }).join("");
  }

  function renderUnusedCells(dom, result) {
    dom.unusedCells.innerHTML = result.unusedCells.length
      ? result.unusedCells.map(function (cell) {
        return '<div class="unused-cell"><span>' + escapeHtml(cell.id) + '</span><strong>' + formatNumber(cell.capacity) + ' mAh</strong></div>';
      }).join("")
      : '<p>Todas as células foram utilizadas.</p>';
  }

  function renderTechnicalDetails(dom, result) {
    const items = [
      ["Tentativas analisadas", String(result.attempts)],
      ["Tempo de processamento", formatNumber(result.elapsedMs, 2) + " ms"],
      ["Estratégia", result.strategy],
      ["Score final", result.scoreText],
      ["Capacidade mínima", formatNumber(result.minCapacity) + " mAh"],
      ["Range", formatNumber(result.range) + " mAh"],
      ["Desvio padrão", formatNumber(result.standardDeviation, 4)]
    ];
    dom.technicalDetails.innerHTML = '<dl>' + items.map(function (item) {
      return '<div><dt>' + escapeHtml(item[0]) + '</dt><dd>' + escapeHtml(item[1]) + '</dd></div>';
    }).join("") + '</dl>';
  }

  function renderCellTable(dom, cells, result) {
    const rows = cells.map(function (cell) {
      const group = result && result.cellGroupMap.has(cell.id) ? result.cellGroupMap.get(cell.id) : "";
      return {
        id: cell.id,
        capacity: cell.capacity,
        status: group ? "Utilizada" : "Não utilizada",
        group: group || "—"
      };
    });
    rows.sort(function (a, b) {
      let value = 0;
      if (state.sort.key === "id") value = naturalIdSort(a.id, b.id);
      if (state.sort.key === "capacity") value = a.capacity - b.capacity;
      if (state.sort.key === "status") value = a.status.localeCompare(b.status, "pt-BR");
      if (state.sort.key === "group") value = a.group.localeCompare(b.group, "pt-BR", { numeric: true });
      return state.sort.direction === "asc" ? value : -value;
    });
    dom.cellTableBody.innerHTML = rows.map(function (row) {
      const statusClass = row.status === "Utilizada" ? "status-used" : "status-unused";
      return '<tr>' +
        '<td>' + escapeHtml(row.id) + '</td>' +
        '<td>' + formatNumber(row.capacity) + ' mAh</td>' +
        '<td class="' + statusClass + '">' + escapeHtml(row.status) + '</td>' +
        '<td>' + escapeHtml(row.group) + '</td>' +
      '</tr>';
    }).join("");
  }

  function renderEmpty(dom) {
    dom.emptyState.classList.remove("hidden");
    dom.resultPanel.classList.add("hidden");
    dom.unusedPanel.classList.add("hidden");
    dom.tablePanel.classList.add("hidden");
    state.lastResult = null;
  }

  function setMessage(dom, text, ok) {
    dom.message.textContent = text;
    dom.message.classList.toggle("ok", Boolean(ok));
  }

  function saveState(dom) {
    const payload = {
      cellsText: dom.cellInput.value,
      series: dom.seriesInput.value,
      parallel: dom.parallelInput.value,
      sortBeforeOptimize: dom.sortBeforeOptimizeInput.checked,
      mode: document.querySelector("input[name='selectionMode']:checked").value,
      theme: document.documentElement.dataset.theme || "",
      sort: state.sort,
      lastResultInput: state.lastResult ? {
        cellsText: dom.cellInput.value,
        series: state.lastResult.series,
        parallel: state.lastResult.parallel,
        mode: document.querySelector("input[name='selectionMode']:checked").value
      } : null
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  }

  function loadState(dom) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved) return;
      dom.cellInput.value = saved.cellsText || "";
      dom.seriesInput.value = saved.series || 5;
      dom.parallelInput.value = saved.parallel || 2;
      dom.sortBeforeOptimizeInput.checked = saved.sortBeforeOptimize !== false;
      const mode = saved.mode || "best";
      const radio = document.querySelector("input[name='selectionMode'][value='" + mode + "']");
      if (radio) radio.checked = true;
      if (saved.theme) document.documentElement.dataset.theme = saved.theme;
      if (saved.sort) state.sort = saved.sort;
      if (saved.lastResultInput && saved.lastResultInput.cellsText === dom.cellInput.value) {
        const parsed = parseCells(dom.cellInput.value);
        const series = Number(dom.seriesInput.value);
        const parallel = Number(dom.parallelInput.value);
        const validation = validatePackConfiguration(parsed.cells, series, parallel);
        if (!parsed.invalid.length && validation.valid) {
          state.cells = parsed.cells;
          state.lastResult = optimizePack(parsed.cells, series, parallel, mode);
          renderResult(dom, parsed.cells, state.lastResult);
        }
      }
    } catch (error) {
      localStorage.removeItem(STORAGE_KEY);
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (char) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char];
    });
  }

  if (typeof window !== "undefined") {
    window.BatteryPackCalculator = {
      parseCells: parseCells,
      sortCellsTextByCapacity: sortCellsTextByCapacity,
      validatePackConfiguration: validatePackConfiguration,
      optimizePack: optimizePack,
      compareSolutions: compareSolutions,
      calculateStatistics: calculateStatistics
    };
    document.addEventListener("DOMContentLoaded", initializeUi);
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      CAPACITY_TOLERANCE_MAH: CAPACITY_TOLERANCE_MAH,
      parseCells: parseCells,
      sortCellsTextByCapacity: sortCellsTextByCapacity,
      validatePackConfiguration: validatePackConfiguration,
      optimizePack: optimizePack,
      compareSolutions: compareSolutions,
      calculateStatistics: calculateStatistics,
      EXAMPLE_CELLS: EXAMPLE_CELLS
    };
  }
})();
