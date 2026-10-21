// Mina Ahmadi — front-end-only contact form validation with friendly inline errors.
(function () {
  var form = document.getElementById('contactForm');
  if (!form) return;

  var fields = {
    name: { input: document.getElementById('fName'), error: document.getElementById('eName'),
      test: function (v) { return v.trim().length >= 2; }, msg: 'Please tell me your name (at least 2 characters).' },
    email: { input: document.getElementById('fEmail'), error: document.getElementById('eEmail'),
      test: function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()); }, msg: 'That email doesn\'t look complete — check for an @ and a domain.' },
    message: { input: document.getElementById('fMsg'), error: document.getElementById('eMsg'),
      test: function (v) { return v.trim().length >= 20; }, msg: 'A little more detail helps — at least 20 characters about your project.' }
  };
  var note = document.getElementById('formNote');

  function validate(key, showError) {
    var f = fields[key];
    var ok = f.test(f.input.value);
    f.input.classList.toggle('is-invalid', !ok && showError);
    f.input.setAttribute('aria-invalid', String(!ok && showError));
    f.error.textContent = (!ok && showError) ? f.msg : '';
    return ok;
  }

  Object.keys(fields).forEach(function (key) {
    fields[key].input.addEventListener('blur', function () { validate(key, true); });
    fields[key].input.addEventListener('input', function () {
      if (fields[key].input.classList.contains('is-invalid')) validate(key, true);
    });
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var results = Object.keys(fields).map(function (key) { return validate(key, true); });
    if (results.indexOf(false) !== -1) {
      note.textContent = '';
      var firstBad = Object.keys(fields).find(function (key) { return !fields[key].test(fields[key].input.value); });
      if (firstBad) fields[firstBad].input.focus();
      return;
    }
    var name = fields.name.input.value.trim().split(' ')[0];
    note.textContent = 'Thank you, ' + name + ' — your message is ready. (Demo form: nothing was sent. Connect it to your email service to go live.)';
    note.classList.add('is-success');
    form.reset();
    Object.keys(fields).forEach(function (key) { fields[key].input.classList.remove('is-invalid'); fields[key].error.textContent = ''; });
  });
})();
