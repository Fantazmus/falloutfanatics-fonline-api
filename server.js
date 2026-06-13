      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function getOverallLabel(value) {
    if (value === "online") {
      return "Сигналы в норме";
    }

    if (value === "degraded") {
      return "Есть проблемы";
    }

    return "Нужна проверка";
  }

  function getStatusLabel(value) {
    if (value === "online") {
      return "ONLINE";
    }

    if (value === "offline") {
      return "OFFLINE";
    }

    return "UNKNOWN";
  }

  function updateSummary(payload) {
    var summary = payload.summary || {};

    elements.summarySignals.textContent = formatNumber(summary.signalCount || 0);
    elements.summaryAvailable.textContent = formatNumber(summary.availableCount || 0);
    elements.summaryPlayers.textContent = summary.steamPlayers == null ? "—" : formatNumber(summary.steamPlayers);
    elements.summaryChecked.textContent = formatCheckedAt(payload.fetchedAt);
    elements.summaryStatus.textContent = getOverallLabel(summary.overallStatus);
    elements.summaryCache.textContent = payload.cached ? "Кэшированный ответ API" : "Свежая проверка";
    elements.metaSource.textContent = payload.source === "official-public-signals"
      ? "Steam + Bethesda"
      : "Локальный fallback";
  }

  function matchesFilter(item, filterValue) {
    if (!filterValue) {
      return true;
    }

    var haystack = [
      item.name,
      item.sourceLabel,
      item.title,
      item.description,
      item.note
    ].join(" ").toLowerCase();

    return haystack.indexOf(filterValue) !== -1;
  }

  function renderGrid(payload) {
    var filterValue = currentFilter;
    var items = Array.isArray(payload.items) ? payload.items.filter(function (item) {
      return matchesFilter(item, filterValue);
    }) : [];

    if (!items.length) {
      elements.grid.innerHTML = '<div class="ff76Monitor__empty">Карточки не найдены. Попробуй другой фильтр.</div>';
      return;
    }

    elements.grid.innerHTML = items.map(function (item) {
      var pillClass = "ff76Card__pill ff76Card__pill--" + escapeHtml(item.status || "unknown");
      var valueLabel = item.valueLabel || (item.value == null ? "—" : String(item.value));
      var buttons = [];

      if (item.url) {
        buttons.push('<a class="ff76Card__button" href="' + escapeHtml(item.url) + '" target="_blank" rel="noreferrer">Открыть</a>');
      }

      return [
        '<article class="ff76Card">',
        '<div class="ff76Card__head">',
        '<div>',
        '<div class="ff76Card__eyebrow">' + escapeHtml(item.sourceLabel || "Fallout 76") + '</div>',
        '<h2>' + escapeHtml(item.name || "Сигнал") + '</h2>',
        '</div>',
        '<span class="' + pillClass + '">' + escapeHtml(getStatusLabel(item.status)) + '</span>',
        '</div>',
        '<p class="ff76Card__desc">' + escapeHtml(item.description || "") + '</p>',
        '<div class="ff76Card__stats">',
        '<div class="ff76Card__stat"><span>Значение</span><b>' + escapeHtml(valueLabel) + '</b></div>',
        '<div class="ff76Card__stat"><span>Источник</span><b>' + escapeHtml(item.sourceLabel || "Мониторинг") + '</b></div>',
        '<div class="ff76Card__stat"><span>HTTP / API</span><b>' + escapeHtml(item.httpStatus ? ("HTTP " + item.httpStatus) : (item.kind === "players" ? "LIVE" : "—")) + '</b></div>',
        '<div class="ff76Card__stat"><span>Страница</span><b>' + escapeHtml(item.title || "Открыть источник") + '</b></div>',
        '</div>',
        buttons.length ? '<div class="ff76Card__actions">' + buttons.join("") + '</div>' : "",
        '<div class="ff76Card__note">' + escapeHtml(item.note || "") + '</div>',
        '</article>'
      ].join("");
    }).join("");
  }

  async function loadPayload(forceRefresh) {
    var targetUrl = API_URL + (API_URL.indexOf("?") === -1 ? "?" : "&") + "t=" + Date.now();

    elements.metaSource.textContent = forceRefresh ? "Обновление..." : "Загрузка...";

    try {
      var response = await fetch(targetUrl, {
        headers: {
          Accept: "application/json"
        },
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      var payload = await response.json();
      currentPayload = payload && payload.items ? payload : FALLBACK_PAYLOAD;
    } catch (error) {
      currentPayload = FALLBACK_PAYLOAD;
      currentPayload.fetchedAt = "";
      currentPayload.cached = false;
      currentPayload.summary.overallStatus = "unknown";
    }

    updateSummary(currentPayload);
    renderGrid(currentPayload);
  }

  elements.reloadButton.addEventListener("click", function () {
    loadPayload(true);
  });

  elements.searchInput.addEventListener("input", function () {
    currentFilter = String(elements.searchInput.value || "").trim().toLowerCase();
    renderGrid(currentPayload);
  });

  updateSummary(FALLBACK_PAYLOAD);
  renderGrid(FALLBACK_PAYLOAD);
  loadPayload(false);
})();
</script>
</body>
