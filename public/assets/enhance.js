// Fineprint's one optional script: comfort only, never the content. Every screen works without it.
// - A screenshot link (a[data-full]) to this site opens the full image in a <dialog> over the page instead of
//   leaving it; without <dialog> support, with a modifier key held, or to another origin, it is a plain link.
// - A command on About (pre[data-copy]) gets a Copy button that writes its text to the clipboard and says
//   "Copied"; without the Clipboard API no button is added.
// Both do nothing on a screen without their elements. Motion lives in site.css, off under reduced motion.
(function () {
  "use strict";

  // --- The screenshot lightbox ---------------------------------------------------------------------------

  var dialog = null;
  var image = null;
  var opener = null;

  function buildDialog() {
    dialog = document.createElement("dialog");
    dialog.className = "lightbox";
    dialog.setAttribute("aria-labelledby", "lightbox-caption");

    var bar = document.createElement("div");
    bar.className = "lightbox-bar";
    var caption = document.createElement("p");
    caption.className = "lightbox-caption";
    caption.id = "lightbox-caption";
    var open = document.createElement("a");
    open.className = "lightbox-open";
    open.textContent = "Open the image on its own";
    var close = document.createElement("button");
    close.type = "button";
    close.className = "btn secondary lightbox-close";
    close.textContent = "Close";
    close.addEventListener("click", function () {
      dialog.close();
    });
    bar.appendChild(caption);
    bar.appendChild(open);
    bar.appendChild(close);

    var frame = document.createElement("div");
    frame.className = "lightbox-frame";
    image = document.createElement("img");
    image.decoding = "async";
    frame.appendChild(image);

    dialog.appendChild(bar);
    dialog.appendChild(frame);
    // A click on the backdrop (the dialog element itself, outside its content) closes it.
    dialog.addEventListener("click", function (event) {
      if (event.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", function () {
      image.removeAttribute("src");
      if (opener && document.contains(opener)) opener.focus();
      opener = null;
    });
    document.body.appendChild(dialog);
  }

  function openLightbox(link) {
    if (dialog === null) buildDialog();
    var thumb = link.querySelector("img");
    var alt = thumb ? thumb.getAttribute("alt") || "" : "";
    var figure = link.closest("figure");
    var caption = figure ? figure.querySelector("figcaption") : null;
    image.alt = alt;
    image.src = link.getAttribute("href");
    dialog.querySelector(".lightbox-caption").textContent = caption ? caption.textContent : alt;
    dialog.querySelector(".lightbox-open").setAttribute("href", link.getAttribute("href"));
    opener = link;
    dialog.showModal();
    dialog.querySelector(".lightbox-close").focus();
    dialog.querySelector(".lightbox-frame").scrollTop = 0;
  }

  if (typeof HTMLDialogElement === "function" && typeof HTMLDialogElement.prototype.showModal === "function") {
    document.addEventListener("click", function (event) {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      var link = event.target instanceof Element ? event.target.closest("a[data-full]") : null;
      if (link === null || !link.getAttribute("href")) return;
      // Only an image on this site opens over the page; any other link is left to the browser.
      var target;
      try {
        target = new URL(link.getAttribute("href"), location.href);
      } catch (err) {
        return;
      }
      if (target.origin !== location.origin) return;
      event.preventDefault();
      openLightbox(link);
    });
  }

  // --- Copy buttons -----------------------------------------------------------------------------------------

  var commands = document.querySelectorAll("pre[data-copy]");
  var clipboard = navigator.clipboard;
  if (commands.length === 0 || !clipboard || typeof clipboard.writeText !== "function") return;

  Array.prototype.forEach.call(commands, function (pre) {
    // Each button is named by its endpoint ("Copy command: GET /api/changes"), so a list of buttons can tell them apart.
    var item = pre.closest("li");
    var heading = item ? item.querySelector("h3") : null;
    var what = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim() : "";
    var name = function (verb) {
      return what === "" ? verb + " command" : verb + " command: " + what;
    };
    var button = document.createElement("button");
    button.type = "button";
    button.className = "copy";
    button.textContent = "Copy";
    button.setAttribute("aria-label", name("Copy"));
    var status = document.createElement("span");
    status.className = "vh";
    status.setAttribute("role", "status");
    var timer = 0;

    button.addEventListener("click", function () {
      clipboard.writeText(pre.textContent || "").then(
        function () {
          button.textContent = "Copied";
          button.setAttribute("aria-label", name("Copied"));
          button.classList.add("is-done");
          status.textContent = "Copied to the clipboard";
          clearTimeout(timer);
          timer = setTimeout(function () {
            button.textContent = "Copy";
            button.setAttribute("aria-label", name("Copy"));
            button.classList.remove("is-done");
            status.textContent = "";
          }, 2000);
        },
        function () {
          // Refused (no permission, or the page is not focused): select the command so it can be copied by hand.
          var range = document.createRange();
          range.selectNodeContents(pre);
          var selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
        },
      );
    });

    // site.css reserves the button's place beside (or, on a phone, under) the command, so nothing moves when it appears.
    var box = pre.parentElement;
    if (box) {
      box.appendChild(button);
      box.appendChild(status);
    }
  });
})();
