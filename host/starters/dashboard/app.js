// Pulse — sidebar toggle + chart range switching with two datasets.
(function () {
  var sidebar = document.getElementById('sidebar');
  var menuBtn = document.getElementById('menuBtn');
  var scrim = document.getElementById('scrim');

  function setSidebar(open) {
    sidebar.classList.toggle('is-open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    scrim.hidden = !open;
  }
  menuBtn.addEventListener('click', function () { setSidebar(!sidebar.classList.contains('is-open')); });
  scrim.addEventListener('click', function () { setSidebar(false); });

  // --- Chart ---
  var W = 640, H = 240, PAD = 14;
  var datasets = {
    '14d': {
      label: 'Sessions per day · last 14 days',
      total: 'Total 61,340 sessions',
      axis: ['Oct 8', 'Oct 11', 'Oct 14', 'Oct 17', 'Oct 21'],
      points: [3200, 3600, 3350, 3900, 4200, 4050, 4480, 4300, 4700, 4520, 4900, 4750, 5100, 4980]
    },
    '12w': {
      label: 'Sessions per week · last 12 weeks',
      total: 'Total 512,900 sessions',
      axis: ['Aug', 'Sep', 'Oct'],
      points: [28400, 30200, 29800, 32600, 34100, 33500, 36800, 38900, 40200, 39600, 42800, 44900]
    }
  };

  var line = document.getElementById('chartLine');
  var area = document.getElementById('chartArea');
  var pointsG = document.getElementById('chartPoints');
  var axisEl = document.getElementById('chartAxis');
  var sub = document.getElementById('chartSub');
  var totalEl = document.getElementById('chartTotal');

  function render(key) {
    var data = datasets[key];
    var max = Math.max.apply(null, data.points) * 1.15;
    var min = Math.min.apply(null, data.points) * 0.75;
    var stepX = (W - PAD * 2) / (data.points.length - 1);
    var coords = data.points.map(function (v, i) {
      var x = PAD + i * stepX;
      var y = H - 20 - ((v - min) / (max - min)) * (H - 60);
      return [Math.round(x * 10) / 10, Math.round(y * 10) / 10];
    });
    var d = coords.map(function (c, i) { return (i === 0 ? 'M' : 'L') + c[0] + ',' + c[1]; }).join(' ');
    line.setAttribute('d', d);
    area.setAttribute('d', d + ' L' + coords[coords.length - 1][0] + ',' + (H - 8) + ' L' + coords[0][0] + ',' + (H - 8) + ' Z');
    pointsG.innerHTML = coords.map(function (c) {
      return '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="3.5"></circle>';
    }).join('');
    axisEl.innerHTML = data.axis.map(function (t) { return '<span>' + t + '</span>'; }).join('');
    sub.textContent = data.label;
    totalEl.textContent = data.total;
  }

  document.querySelectorAll('.range-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.range-btn').forEach(function (b) { b.classList.remove('is-active'); });
      btn.classList.add('is-active');
      render(btn.getAttribute('data-range'));
    });
  });

  render('14d');
})();
