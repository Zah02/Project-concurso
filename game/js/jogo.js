'use strict';

const canvas = document.querySelector('#game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
const minimap = document.querySelector('#minimap');
const mctx = minimap.getContext('2d');
mctx.imageSmoothingEnabled = false;

// O canvas é a janela de 128x128 píxeis do mapa original.
const VIEW_W = 128, VIEW_H = 128;
const WORLD_W = 1024, WORLD_H = 512;
const SCALE = 4; // cada píxel lógico aparece como 4x4 píxeis no ecrã

const loadImage = (src) => {
  const img = new Image();
  img.src = src;
  return img;
};
const images = {
  world: loadImage('mapa/mundo.png'),
  idle: loadImage('sprites/jogador-parado.png'),
  walk: loadImage('sprites/jogador-andar.png'),
  sea: loadImage('sprites/inimigo-mar.png'),
  dry: loadImage('sprites/inimigo-seco.png'),
  final: loadImage('sprites/boss-final.png')
};

const startPlayer = () => ({ x: (WORLD_W - 16) / 2, y: (WORLD_H - 16) / 2, w: 16, h: 16, speed: 78, hp: 3, faceX: 0, faceY: 1, invuln: 0, animTime: 0 });
let player = startPlayer();
let camera = { x: 0, y: 0 };
let projectiles = [];
const MAGAZINE_SIZE = 12;
const SHOT_COOLDOWN = 0.2;
const RELOAD_DURATION = 2;
let ammo = MAGAZINE_SIZE;
let shotCooldown = 0;
let reloadTimer = 0;
let reloading = false;
let paused = false;
let gameOver = false;
let won = false;
let firing = false;
let trophy = { x: 510, y: 75, active: false, collected: false };
let lastTime = 0;
let notice = 'Explore the world and defeat pollution!';
let noticeTime = 3;

// Coordenadas aproximadas para os biomas no mapa fornecido. Ajustáveis.
const biomes = [
  { name: 'Coast', power: 'Water', x1: 0, y1: 0, x2: 255, y2: 255 },
  { name: 'Drylands', power: 'Seeds', x1: 0, y1: 256, x2: 300, y2: 512 },
  { name: 'Forest', power: 'Wind', x1: 260, y1: 230, x2: 770, y2: 512 },
  { name: 'Snow Mountains', power: 'Ice', x1: 700, y1: 0, x2: 1024, y2: 270 },
  { name: 'Corrupted Lands', power: 'Biodiversity', x1: 300, y1: 0, x2: 710, y2: 230 }
];
const bosses = [
  { id: 'sea', name: 'Sea Guardian', x: 120, y: 100, w: 32, h: 32, hp: 24, maxHp: 24, image: images.sea, power: 'Water', defeated: false, animal: 'Sea turtle' },
  { id: 'dry', name: 'Drylands Guardian', x: 150, y: 390, w: 32, h: 32, hp: 24, maxHp: 24, image: images.dry, power: 'Seeds', defeated: false, animal: 'Desert fox' },
  { id: 'forest', name: 'Forest Guardian', x: 610, y: 390, w: 32, h: 32, hp: 24, maxHp: 24, image: images.dry, power: 'Wind', defeated: false, animal: 'Lynx' },
  { id: 'snow', name: 'Ice Guardian', x: 850, y: 100, w: 32, h: 32, hp: 24, maxHp: 24, image: images.sea, power: 'Ice', defeated: false, animal: 'Arctic fox' },
  { id: 'final', name: 'Corrupted Final Boss', x: 510, y: 75, w: 48, h: 48, hp: 48, maxHp: 48, image: images.final, power: 'Biodiversity', defeated: false, final: true, animal: null }
];
const keys = new Set();

function currentBiome(x = player.x + 8, y = player.y + 8) {
  // A ordem faz a zona corrompida ter prioridade sobre regiões que se sobrepõem.
  return [...biomes].reverse().find(b => x >= b.x1 && x < b.x2 && y >= b.y1 && y < b.y2) || biomes[0];
}
function allGuardiansDefeated() { return bosses.filter(b => !b.final).every(b => b.defeated); }
function setNotice(text, duration = 2.5) { notice = text; noticeTime = duration; }
function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

window.addEventListener('keydown', e => {
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'Escape' && !e.repeat && !gameOver && !won) paused = !paused;
});
window.addEventListener('keyup', e => keys.delete(e.code));
canvas.addEventListener('pointerdown', e => { firing = true; canvas.setPointerCapture?.(e.pointerId); if (!paused && !gameOver && !won) attack(); });
window.addEventListener('pointerup', () => { firing = false; });
window.addEventListener('pointercancel', () => { firing = false; });
window.addEventListener('blur', () => { keys.clear(); firing = false; });
document.querySelector('#win-restart').addEventListener('click', resetGame);
document.querySelector('#restart').addEventListener('click', resetGame);
document.querySelector('#fullscreen').addEventListener('click', async () => {
  try {
    if (!document.fullscreenElement) await document.querySelector('#gameLayout').requestFullscreen();
    else await document.exitFullscreen();
  } catch (error) { setNotice('Could not enable fullscreen in this browser.'); }
});

function attack() {
  if (reloading || shotCooldown > 0 || ammo <= 0) {
    if (reloading) setNotice('Reloading...', 0.5);
    else if (ammo <= 0) startReload();
    return;
  }
  const biome = currentBiome();
  // Procura o boss vivo mais próximo e escolhe uma das oito direções permitidas.
  const available = bosses.filter(b => !b.defeated && (!b.final || allGuardiansDefeated()));
  let dx = player.faceX, dy = player.faceY;
  if (available.length) {
    const px = player.x + player.w / 2, py = player.y + player.h / 2;
    const target = available.reduce((best, b) => {
      const d = Math.hypot((b.x + b.w / 2) - px, (b.y + b.h / 2) - py);
      return !best || d < best.distance ? { boss: b, distance: d } : best;
    }, null).boss;
    dx = target.x + target.w / 2 - px;
    dy = target.y + target.h / 2 - py;
  }
  if (Math.abs(dx) > Math.abs(dy) * 2) dy = 0;
  else if (Math.abs(dy) > Math.abs(dx) * 2) dx = 0;
  dx = Math.sign(dx); dy = Math.sign(dy);
  if (dx === 0 && dy === 0) dy = 1;
  const len = Math.hypot(dx, dy);
  projectiles.push({
    x: player.x + player.w / 2, y: player.y + player.h / 2,
    dx: dx / len, dy: dy / len,
    type: biome.power, speed: 145, range: 180, travelled: 0
  });
  ammo--;
  shotCooldown = SHOT_COOLDOWN;
  setNotice('Attack: ' + biome.power + '!', 0.8);
  if (ammo === 0) startReload();
}
function startReload() {
  if (reloading) return;
  reloading = true;
  reloadTimer = RELOAD_DURATION;
  setNotice('Reloading for 2 seconds...', 2);
}

function update(dt) {
  if (paused || gameOver || won) return;
  if (noticeTime > 0) noticeTime -= dt;
  shotCooldown = Math.max(0, shotCooldown - dt);
  if (reloading) {
    reloadTimer -= dt;
    if (reloadTimer <= 0) { reloading = false; ammo = MAGAZINE_SIZE; setNotice('Magazine full!', 1); }
  }
  player.invuln = Math.max(0, player.invuln - dt);
  if ((keys.has('Space') || firing) && !reloading && ammo > 0 && shotCooldown <= 0) attack();

  let dx = 0, dy = 0;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) dx--;
  if (keys.has('KeyD') || keys.has('ArrowRight')) dx++;
  if (keys.has('KeyW') || keys.has('ArrowUp')) dy--;
  if (keys.has('KeyS') || keys.has('ArrowDown')) dy++;
  const moving = dx !== 0 || dy !== 0;
  if (moving) {
    const n = Math.hypot(dx, dy); dx /= n; dy /= n;
    player.faceX = dx; player.faceY = dy;
    player.x += dx * player.speed * dt;
    player.y += dy * player.speed * dt;
    player.animTime += dt;
  } else player.animTime = 0;

  // Por enquanto o mapa não tem uma máscara de colisão; o jogador fica dentro dos limites.
  player.x = Math.max(0, Math.min(WORLD_W - player.w, player.x));
  player.y = Math.max(0, Math.min(WORLD_H - player.h, player.y));

  // Inimigos simples perseguem o jogador quando estão suficientemente perto.
  for (const boss of bosses) {
    if (boss.defeated || (boss.final && !allGuardiansDefeated())) continue;
    const cx = boss.x + boss.w / 2, cy = boss.y + boss.h / 2;
    const px = player.x + player.w / 2, py = player.y + player.h / 2;
    const dist = Math.hypot(px - cx, py - cy);
    if (dist < 76 && dist > 1) {
      boss.x += ((px - cx) / dist) * 18 * dt;
      boss.y += ((py - cy) / dist) * 18 * dt;
    }
    if (rectsOverlap(player, boss) && player.invuln <= 0) {
      player.hp--;
      player.invuln = 1.2;
      setNotice('You were hit! Move away from the enemy.');
      if (player.hp <= 0) { gameOver = true; setNotice('You were defeated. Press Restart.'); }
    }
  }

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    const step = p.speed * dt;
    p.x += p.dx * step; p.y += p.dy * step; p.travelled += step;
    let hitBoss = false;
    for (const boss of bosses) {
      if (boss.defeated || (boss.final && !allGuardiansDefeated())) continue;
      const target = { x: boss.x, y: boss.y, w: boss.w, h: boss.h };
      if (p.x >= target.x && p.x <= target.x + target.w && p.y >= target.y && p.y <= target.y + target.h) {
        // Each shot deals 1 damage: 12 shots remove half a guardian's 24 HP.
        const damage = 1;
        boss.hp = Math.max(0, boss.hp - damage);
        hitBoss = true;
        setNotice(boss.name + ': ' + boss.hp + '/' + boss.maxHp + ' HP');
        if (boss.hp <= 0) {
          boss.defeated = true;
          if (boss.final) {
            trophy.active = true;
            trophy.x = boss.x + boss.w / 2 - 6;
            trophy.y = boss.y + boss.h / 2 - 6;
            setNotice('The Corrupted Boss is defeated! Find and collect the trophy.');
          } else {
            setNotice(boss.name + ' defeated! Rescued animal: ' + boss.animal + '.');
          }
        }
        break;
      }
    }
    if (hitBoss || p.travelled >= p.range || p.x < 0 || p.y < 0 || p.x > WORLD_W || p.y > WORLD_H) projectiles.splice(i, 1);
  }

  if (trophy.active && !trophy.collected && Math.hypot((player.x + 8) - (trophy.x + 6), (player.y + 8) - (trophy.y + 6)) < 17) {
    trophy.collected = true; won = true;
    document.querySelector('#win-screen').classList.remove('hidden');
    setNotice('You Win!');
  }

  camera.x = Math.max(0, Math.min(WORLD_W - VIEW_W, player.x + 8 - VIEW_W / 2));
  camera.y = Math.max(0, Math.min(WORLD_H - VIEW_H, player.y + 8 - VIEW_H / 2));
  updateUI();
}
function draw() {
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  if (images.world.complete && images.world.naturalWidth) {
    ctx.drawImage(images.world, camera.x, camera.y, VIEW_W, VIEW_H, 0, 0, VIEW_W, VIEW_H);
  } else { ctx.fillStyle = '#294b35'; ctx.fillRect(0, 0, VIEW_W, VIEW_H); }

  for (const boss of bosses) {
    if (boss.defeated || (boss.final && !allGuardiansDefeated())) continue;
    const x = Math.round(boss.x - camera.x), y = Math.round(boss.y - camera.y);
    if (x > VIEW_W || y > VIEW_H || x + boss.w < 0 || y + boss.h < 0) continue;
    if (boss.image.complete && boss.image.naturalWidth) ctx.drawImage(boss.image, x, y, boss.w, boss.h);
    else { ctx.fillStyle = boss.final ? '#b34be0' : '#d45b40'; ctx.fillRect(x, y, boss.w, boss.h); }
    ctx.fillStyle = '#261c25'; ctx.fillRect(x, y - 5, boss.w, 3);
    ctx.fillStyle = '#f04757'; ctx.fillRect(x, y - 5, boss.w * boss.hp / boss.maxHp, 3);
  }

  for (const p of projectiles) {
    const colors = { Water:'#65d9ff', Seeds:'#9df06d', Wind:'#f5f5dc', Ice:'#8ceaff', Biodiversity:'#df7bff' };
    ctx.fillStyle = colors[p.type] || '#fff';
    ctx.fillRect(Math.round(p.x - camera.x - 2), Math.round(p.y - camera.y - 2), 5, 5);
  }

  if (trophy.active && !trophy.collected) {
    const tx = Math.round(trophy.x - camera.x), ty = Math.round(trophy.y - camera.y);
    ctx.fillStyle = '#ffd84d'; ctx.fillRect(tx + 3, ty, 7, 5); ctx.fillRect(tx + 5, ty + 5, 3, 4); ctx.fillRect(tx + 2, ty + 9, 9, 2);
    ctx.fillStyle = '#fff3a3'; ctx.fillRect(tx + 5, ty + 1, 2, 2);
  }

  const px = Math.round(player.x - camera.x), py = Math.round(player.y - camera.y);
  const walking = keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD') || keys.has('ArrowUp') || keys.has('ArrowDown') || keys.has('ArrowLeft') || keys.has('ArrowRight');
  const sprite = walking && Math.floor(player.animTime / 0.18) % 2 === 1 ? images.walk : images.idle;
  if (player.invuln > 0 && Math.floor(player.invuln * 12) % 2 === 0) {
    // Piscar durante a invulnerabilidade.
  } else if (sprite.complete && sprite.naturalWidth) {
    // Espelha o sprite quando o jogador olha para a esquerda.
    if (player.faceX < 0) {
      ctx.save();
      ctx.translate(px + 16, py);
      ctx.scale(-1, 1);
      ctx.drawImage(sprite, 0, 0, 16, 16);
      ctx.restore();
    } else {
      ctx.drawImage(sprite, px, py, 16, 16);
    }
  } else { ctx.fillStyle = '#5ab8ff'; ctx.fillRect(px, py, 16, 16); }

  drawMinimap();
  updateBossRoster();

  if (paused || gameOver || (won && !document.querySelector('#win-screen').classList.contains('hidden'))) {
    ctx.fillStyle = '#000b'; ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    ctx.textAlign = 'center'; ctx.fillStyle = won ? '#a7f08f' : '#fff'; ctx.font = 'bold 10px monospace';
    ctx.fillText(paused ? 'PAUSED' : gameOver ? 'GAME OVER' : 'YOU WIN!', 64, 59);
    ctx.font = '6px monospace'; ctx.fillText(paused ? 'Press ESC to resume' : 'Use Restart on screen', 64, 71); ctx.textAlign = 'left';
  }
}
function drawMinimap() {
  mctx.clearRect(0, 0, minimap.width, minimap.height);
  if (images.world.complete && images.world.naturalWidth) mctx.drawImage(images.world, 0, 0, minimap.width, minimap.height);
  // Boss markers and player marker
  for (const b of bosses) {
    if (b.defeated) continue;
    mctx.fillStyle = b.final ? '#ff55ff' : '#ff6255';
    mctx.fillRect(b.x / WORLD_W * minimap.width - 2, b.y / WORLD_H * minimap.height - 2, 5, 5);
  }
  mctx.fillStyle = '#fff56b';
  mctx.fillRect(player.x / WORLD_W * minimap.width - 2, player.y / WORLD_H * minimap.height - 2, 5, 5);
  mctx.strokeStyle = '#d9f6c7'; mctx.lineWidth = 1;
  mctx.strokeRect(camera.x / WORLD_W * minimap.width, camera.y / WORLD_H * minimap.height, VIEW_W / WORLD_W * minimap.width, VIEW_H / WORLD_H * minimap.height);
}
function updateBossRoster() {
  for (const id of ['sea','dry','forest','snow','final']) {
    const boss = bosses.find(b => b.id === id);
    const slot = document.querySelector('#slot-' + id);
    if (!slot || !boss) continue;
    slot.classList.toggle('defeated', boss.defeated);
    let mark = slot.querySelector('.boss-shadow');
    if (mark && !mark.querySelector('img')) {
      mark.textContent = '';
      const portrait = document.createElement('img');
      portrait.alt = boss.name;
      portrait.src = boss.image.src;
      mark.appendChild(portrait);
    }
    if (mark) {
      const portrait = mark.querySelector('img');
      if (portrait) portrait.style.filter = boss.defeated ? 'none' : 'brightness(0)';
      mark.style.opacity = boss.defeated ? '1' : '.8';
    }
    if (id === 'final' && !allGuardiansDefeated() && !boss.defeated) slot.classList.add('locked');
    else slot.classList.remove('locked');
  }
}

function updateUI() {
  const b = currentBiome();
  document.querySelector('#biome').textContent = 'Biome: ' + b.name;
  document.querySelector('#attack').textContent = 'Power: ' + b.power;
  document.querySelector('#health').textContent = 'Health: ' + '♥ '.repeat(player.hp).trim() + (player.hp ? '' : '0');
  const ammoEl = document.querySelector('#ammo');
  if (ammoEl) ammoEl.textContent = reloading ? 'Ammo: reloading ' + Math.max(0, reloadTimer).toFixed(1) + 's' : 'Ammo: ' + ammo + '/' + MAGAZINE_SIZE;
  document.querySelector('#message').textContent = noticeTime > 0 || paused || gameOver || won ? notice : (allGuardiansDefeated() ? 'The final boss has been unlocked!' : 'Defeat the guardians and rescue the animals.');
}
function resetGame() {
  player = startPlayer(); camera = { x: 0, y: 0 }; projectiles = []; ammo = MAGAZINE_SIZE; shotCooldown = 0; reloadTimer = 0; reloading = false; paused = false; gameOver = false; won = false;
  bosses[0].x = 120; bosses[0].y = 100;
  bosses[1].x = 150; bosses[1].y = 390;
  bosses[2].x = 610; bosses[2].y = 390;
  bosses[3].x = 850; bosses[3].y = 100;
  bosses[4].x = 510; bosses[4].y = 75;
  trophy = { x: 510, y: 75, active: false, collected: false };
  firing = false; document.querySelector('#win-screen').classList.add('hidden');
  for (const b of bosses) { b.hp = b.maxHp; b.defeated = false; }
  setNotice('The adventure has restarted!'); updateUI();
}
function loop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000 || 0, 0.05);
  lastTime = timestamp;
  update(dt); draw(); requestAnimationFrame(loop);
}
updateUI(); requestAnimationFrame(loop);
