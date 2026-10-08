// По нажатию планета отлетает, сталкивается с другими и толкает их.
// Все расчёты — в пикселях макета (1440×940), поэтому физика
// одинаково работает на любой ширине экрана.
(() => {
  const stage = document.querySelector(".hero__stage");
  const space = document.querySelector(".hero__space");
  if (!stage || !space) return;

  const WIDTH = 1440;
  const HEIGHT = 940;
  const PUSH_SPEED = 1100; // начальная скорость после нажатия, px макета/с
  const FRICTION = 1.1; // затухание скорости, 1/с
  const BOUNCE = 0.85; // упругость столкновений и отскоков от краёв
  const STAR_RADIUS = 0.42; // радиус звезды относительно её блока
  const CONTACT_GAP = 1; // касание считается законченным при зазоре больше, px макета

  const unit = () => space.clientWidth / WIDTH;
  // Композиция стоит по центру окна; стенки — по краям окна, а не макета
  const sideGap = () => space.offsetLeft / unit();
  // Над композицией — зона заголовка: планеты могут залетать на него
  const topGap = () => space.offsetTop / unit();

  const bodies = [...space.querySelectorAll(".planet, .star")].map((el, id) => {
    const u = unit();
    const size = el.offsetWidth / u;
    const radius = el.classList.contains("star") ? size * STAR_RADIUS : size / 2;
    return {
      id,
      el,
      originX: el.offsetLeft / u + size / 2,
      originY: el.offsetTop / u + size / 2,
      dx: 0,
      dy: 0,
      vx: 0,
      vy: 0,
      radius,
      mass: radius * radius,
    };
  });

  const centerX = (b) => b.originX + b.dx;
  const centerY = (b) => b.originY + b.dy;

  const collideWithWalls = (b) => {
    const x = centerX(b);
    const y = centerY(b);
    const minX = -sideGap();
    const maxX = WIDTH + sideGap();
    if (x - b.radius < minX) {
      b.dx += minX + b.radius - x;
      b.vx = Math.abs(b.vx) * BOUNCE;
    } else if (x + b.radius > maxX) {
      b.dx -= x + b.radius - maxX;
      b.vx = -Math.abs(b.vx) * BOUNCE;
    }
    const minY = -topGap();
    if (y - b.radius < minY) {
      b.dy += minY + b.radius - y;
      b.vy = Math.abs(b.vy) * BOUNCE;
    } else if (y + b.radius > HEIGHT) {
      b.dy -= y + b.radius - HEIGHT;
      b.vy = -Math.abs(b.vy) * BOUNCE;
    }
  };

  // Пары, которые сейчас касаются: пока касание длится, звук не повторяется
  const contacts = new Set();

  // Сообщаем о новом столкновении; звук делает scripts/musicEngine.js.
  // strength — относительная скорость удара в долях от скорости толчка
  const emitCollision = (a, b, speed) => {
    space.dispatchEvent(
      new CustomEvent("shapecollision", {
        detail: { a: a.el, b: b.el, strength: Math.min(speed / PUSH_SPEED, 1) },
      })
    );
  };

  const collide = (a, b) => {
    const nx = centerX(b) - centerX(a);
    const ny = centerY(b) - centerY(a);
    const distance = Math.hypot(nx, ny) || 0.001;
    const overlap = a.radius + b.radius - distance;
    const key = a.id + ":" + b.id;
    if (overlap <= 0) {
      if (overlap < -CONTACT_GAP) contacts.delete(key);
      return;
    }
    const isNewContact = !contacts.has(key);
    contacts.add(key);

    const ux = nx / distance;
    const uy = ny / distance;
    const invA = 1 / a.mass;
    const invB = 1 / b.mass;

    // Раздвигаем пересёкшиеся тела пропорционально их массе
    const correction = overlap / (invA + invB);
    a.dx -= ux * correction * invA;
    a.dy -= uy * correction * invA;
    b.dx += ux * correction * invB;
    b.dy += uy * correction * invB;

    // Импульс передаётся, только если тела сближаются
    const approach = (b.vx - a.vx) * ux + (b.vy - a.vy) * uy;
    if (approach >= 0) return;
    const impulse = (-(1 + BOUNCE) * approach) / (invA + invB);
    a.vx -= ux * impulse * invA;
    a.vy -= uy * impulse * invA;
    b.vx += ux * impulse * invB;
    b.vy += uy * impulse * invB;

    if (isNewContact) emitCollision(a, b, -approach);
  };

  let frame = null;
  let lastTime = null;

  const step = (time) => {
    const dt = lastTime === null ? 0 : Math.min(Math.max(time - lastTime, 0) / 1000, 1 / 30);
    lastTime = time;
    const damping = Math.exp(-FRICTION * dt);

    bodies.forEach((b) => {
      b.vx *= damping;
      b.vy *= damping;
      b.dx += b.vx * dt;
      b.dy += b.vy * dt;
      collideWithWalls(b);
    });

    for (let i = 0; i < bodies.length; i++) {
      for (let j = i + 1; j < bodies.length; j++) collide(bodies[i], bodies[j]);
    }

    let moving = false;
    bodies.forEach((b) => {
      b.el.style.setProperty("--px", b.dx.toFixed(2));
      b.el.style.setProperty("--py", b.dy.toFixed(2));
      if (Math.hypot(b.vx, b.vy) > 2) moving = true;
      else b.vx = b.vy = 0;
    });

    frame = moving ? requestAnimationFrame(step) : null;
  };

  const start = () => {
    if (frame) return;
    lastTime = null;
    frame = requestAnimationFrame(step);
  };

  // Слушаем всю сцену: заголовок лежит поверх планет (ради эффекта
  // наложения), поэтому ищем планету под курсором сквозь буквы
  stage.addEventListener("pointerdown", (event) => {
    const hit = document
      .elementsFromPoint(event.clientX, event.clientY)
      .find((el) => el.matches(".planet, .star"));
    const b = bodies.find((body) => body.el === hit);
    if (!b) return;

    // Планета отлетает в сторону от точки нажатия
    const rect = space.getBoundingClientRect();
    const u = unit();
    const x = (event.clientX - rect.left) / u;
    const y = (event.clientY - rect.top) / u;
    let nx = centerX(b) - x;
    let ny = centerY(b) - y;
    let length = Math.hypot(nx, ny);
    if (length < 1) {
      const angle = Math.random() * Math.PI * 2;
      nx = Math.cos(angle);
      ny = Math.sin(angle);
      length = 1;
    }
    b.vx += (nx / length) * PUSH_SPEED;
    b.vy += (ny / length) * PUSH_SPEED;
    start();
  });
})();
