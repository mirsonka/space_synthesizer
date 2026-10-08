// Появление заголовков 2 и 3 экрана при прокрутке:
// буквы по очереди поднимаются и проявляются, когда заголовок попадает в окно
(function () {
  var titles = document.querySelectorAll(".choose__title, .footer__number");
  if (!("IntersectionObserver" in window) || !titles.length) return;

  titles.forEach(function (title) {
    title.classList.add("reveal");
    title.querySelectorAll(".letter").forEach(function (letter, i) {
      letter.style.setProperty("--i", i);
    });
  });

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target); // анимация проигрывается один раз
      });
    },
    { threshold: 0.4 }
  );

  titles.forEach(function (title) {
    observer.observe(title);
  });
})();
