/* 站点脚本：渲染作品列表 + 表单处理 */
(function () {
  "use strict";

  function renderCard(work) {
    return [
      '<article class="card">',
      '  <img src="' + work.cover + '" alt="' + work.title + '" loading="lazy" />',
      '  <div class="card-body">',
      '    <h3 class="card-title">' + work.title + "</h3>",
      '    <p class="card-meta">' + work.category + " · " + work.year + "</p>",
      "  </div>",
      "</article>",
    ].join("");
  }

  function renderFeatured() {
    var el = document.getElementById("featured-works");
    if (!el) return;
    var featured = (window.WORKS || []).filter(function (w) { return w.featured; }).slice(0, 3);
    el.innerHTML = featured.map(renderCard).join("");
  }

  var currentFilter = "all";

  function renderWorks() {
    var el = document.getElementById("work-list");
    if (!el) return;
    var list = (window.WORKS || []).filter(function (w) {
      return currentFilter === "all" || w.category === currentFilter;
    });
    el.innerHTML = list.length
      ? list.map(renderCard).join("")
      : '<p class="card-meta">这个分类下还没有作品。</p>';
  }

  function initFilters() {
    var chips = document.querySelectorAll(".chip");
    if (!chips.length) return;
    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (c) { c.classList.remove("active"); });
        chip.classList.add("active");
        currentFilter = chip.getAttribute("data-filter");
        renderWorks();
      });
    });
  }

  function initContactForm() {
    var form = document.getElementById("contact-form");
    if (!form) return;
    var status = document.getElementById("form-status");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      status.textContent = "发送中…";
      status.classList.remove("error");
      // 后端接口（当前站点是纯静态的，这个地址不存在）
      fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      })
        .then(function (res) {
          if (!res.ok) throw new Error("HTTP " + res.status);
          status.textContent = "已收到，我会尽快回复你。";
          form.reset();
        })
        .catch(function (err) {
          status.textContent = "发送失败：" + err.message;
          status.classList.add("error");
        });
    });
  }

  function init() {
    renderFeatured();
    renderWorks();
    initFilters();
    initContactForm();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
