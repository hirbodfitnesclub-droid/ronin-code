// Atelier — small interactions: header state, mobile nav, reveal, pricing toggle.
(function () {
  var header = document.getElementById('siteHeader');
  var toggle = document.getElementById('navToggle');
  var nav = document.getElementById('siteNav');

  function onScroll() { header.classList.toggle('is-scrolled', window.scrollY > 12); }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  if (toggle && nav) {
    toggle.addEventListener('click', function () {
      var open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'Close' : 'Menu';
    });
    nav.addEventListener('click', function (e) {
      if (e.target.tagName === 'A') { nav.classList.remove('is-open'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = 'Menu'; }
    });
  }

  // Reveal sections as they enter the viewport (graceful without JS: content is visible by default in no-JS via .reveal fallback in CSS animation).
  if ('IntersectionObserver' in window) {
    document.body.classList.add('js-reveal');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) { entry.target.classList.add('is-visible'); io.unobserve(entry.target); }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });
  }

  // Pricing period toggle swaps amounts + suffixes from data attributes.
  var buttons = document.querySelectorAll('.toggle-btn');
  buttons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      buttons.forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      var period = btn.getAttribute('data-period');
      document.querySelectorAll('.price-amount').forEach(function (el) { el.textContent = el.getAttribute('data-' + period); });
      document.querySelectorAll('.price-per').forEach(function (el) { el.textContent = el.getAttribute('data-' + period); });
    });
  });
})();
