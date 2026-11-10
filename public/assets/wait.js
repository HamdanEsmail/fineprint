// Shows that the site is working while a visitor waits. Every page works without this file.
(function () {
  "use strict";

  // A pressed button says what is happening, and pressing it again does nothing.
  function setBusy(form, button) {
    form.setAttribute("aria-busy", "true");
    if (!button) return;
    button.setAttribute("aria-disabled", "true");
    var label = button.getAttribute("data-busy");
    if (label && button.children.length === 0) {
      button.setAttribute("data-idle", button.textContent || "");
      button.textContent = label;
    }
  }

  function clearBusy() {
    var forms = document.querySelectorAll('form[aria-busy="true"]');
    for (var i = 0; i < forms.length; i++) {
      forms[i].removeAttribute("aria-busy");
      var buttons = forms[i].querySelectorAll('[aria-disabled="true"]');
      for (var j = 0; j < buttons.length; j++) {
        buttons[j].removeAttribute("aria-disabled");
        var idle = buttons[j].getAttribute("data-idle");
        if (idle !== null) {
          buttons[j].textContent = idle;
          buttons[j].removeAttribute("data-idle");
        }
      }
    }
  }

  document.addEventListener("submit", function (event) {
    var form = event.target;
    if (!form || String(form.method).toLowerCase() !== "post") return;
    if (form.getAttribute("aria-busy") === "true") {
      event.preventDefault();
      return;
    }
    setBusy(form, event.submitter || form.querySelector('button[type="submit"]'));
  });

  // A page brought back by the Back button must not still look busy.
  window.addEventListener("pageshow", function (event) {
    if (event.persisted) clearBusy();
  });

  // The clock of a waiting page counts every second between its reloads.
  var clocks = document.querySelectorAll("[data-since]");
  function showClocks() {
    for (var i = 0; i < clocks.length; i++) {
      var since = Date.parse(clocks[i].getAttribute("data-since") || "");
      if (isNaN(since)) continue;
      var seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
      var rest = seconds % 60;
      clocks[i].textContent = Math.floor(seconds / 60) + ":" + (rest < 10 ? "0" : "") + rest;
    }
  }
  if (clocks.length > 0) {
    showClocks();
    setInterval(showClocks, 1000);
  }
})();
