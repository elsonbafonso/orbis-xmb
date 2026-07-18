const app = document.querySelector('#app');
let games = [], selected = 0;
let currentView = 'setup';
let audioContext, ambientGain;
const musicPlayer = new Audio();
let musicTracks = [], currentMusic = '';
let musicPausedForGame = false;
let lastControllerAction = { action: '', time: 0 };
const gamepadState = new Map();
const XMB_THEMES = {
  blue:   { label: 'Azul', colors: ['#0d3f7d', '#1d67ae', '#12447f', '#092345'], wave: '#bfe4ff' },
  purple: { label: 'Roxo', colors: ['#32135f', '#7448a6', '#452477', '#180a38'], wave: '#e2cfff' },
  pink:   { label: 'Rosa', colors: ['#74245d', '#c65b91', '#87335f', '#3c102f'], wave: '#ffd4eb' },
  red:    { label: 'Vermelho', colors: ['#681b26', '#bd4b4d', '#792225', '#350b13'], wave: '#ffd2cf' },
  orange: { label: 'Laranja', colors: ['#7a3712', '#d57b2b', '#914516', '#3e1908'], wave: '#ffe0b5' },
  green:  { label: 'Verde', colors: ['#0e533f', '#349875', '#17654d', '#072e26'], wave: '#c8ffe7' },
  silver: { label: 'Prata', colors: ['#344552', '#8294a0', '#526673', '#1c2932'], wave: '#eff9ff' }
};
let currentTheme = localStorage.getItem('xmb-theme') || 'blue';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[character]);
}

function buildWaves() {
  const svg = document.querySelector('.xmb-waves');
  if (!svg) return;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const period = 900;
  const totalWidth = 1920 + period;
  const twoPi = Math.PI * 2;

  const ribbons = [
    { baseY: 410, amplitude: 78, phase: 0.4, thickPhase: 0.0, hMin: 0.6, hMax: 30, dur: 34, dir: 1, opacity: 0.26 },
    { baseY: 545, amplitude: 104, phase: 2.1, thickPhase: 1.1, hMin: 0.6, hMax: 42, dur: 24, dir: 1, opacity: 0.4 },
    { baseY: 690, amplitude: 66, phase: 3.9, thickPhase: 2.4, hMin: 0.5, hMax: 24, dur: 40, dir: -1, opacity: 0.22 }
  ];

  for (const ribbon of ribbons) {
    const centerAt = x => ribbon.baseY + ribbon.amplitude * Math.sin(twoPi * x / period + ribbon.phase);
    const halfThicknessAt = x => {
      const wave = 0.5 - 0.5 * Math.cos(twoPi * x / period + ribbon.thickPhase);
      return ribbon.hMin + (ribbon.hMax - ribbon.hMin) * Math.pow(wave, 1.6);
    };

    const topPoints = [], bottomPoints = [];
    for (let x = 0; x <= totalWidth; x += 8) {
      const center = centerAt(x);
      const half = halfThicknessAt(x);
      topPoints.push(`${x.toFixed(1)} ${(center - half).toFixed(1)}`);
      bottomPoints.push(`${x.toFixed(1)} ${(center + half).toFixed(1)}`);
    }

    const bodyData = `M ${topPoints.join(' L ')} L ${bottomPoints.reverse().join(' L ')} Z`;

    const group = document.createElementNS(SVG_NS, 'g');

    const body = document.createElementNS(SVG_NS, 'path');
    body.classList.add('wave-body');
    body.setAttribute('d', bodyData);
    body.setAttribute('fill', XMB_THEMES[currentTheme]?.wave || XMB_THEMES.blue.wave);
    body.setAttribute('opacity', String(ribbon.opacity));
    body.setAttribute('filter', 'url(#bodyGlow)');

    const animate = document.createElementNS(SVG_NS, 'animateTransform');
    animate.setAttribute('attributeName', 'transform');
    animate.setAttribute('type', 'translate');
    animate.setAttribute('from', ribbon.dir > 0 ? '0 0' : `-${period} 0`);
    animate.setAttribute('to', ribbon.dir > 0 ? `-${period} 0` : '0 0');
    animate.setAttribute('dur', `${ribbon.dur}s`);
    animate.setAttribute('repeatCount', 'indefinite');

    group.append(body, animate);
    svg.append(group);
  }
}

function applyTheme(name, save = true) {
  const theme = XMB_THEMES[name] || XMB_THEMES.blue;
  currentTheme = XMB_THEMES[name] ? name : 'blue';
  const [a, b, c, d] = theme.colors;
  document.body.style.setProperty('--xmb-a', a);
  document.body.style.setProperty('--xmb-b', b);
  document.body.style.setProperty('--xmb-c', c);
  document.body.style.setProperty('--xmb-d', d);
  document.querySelectorAll('.wave-body').forEach(wave => wave.setAttribute('fill', theme.wave));
  document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.classList.toggle('active', swatch.dataset.theme === currentTheme);
  });
  if (save) localStorage.setItem('xmb-theme', currentTheme);
}

buildWaves();
applyTheme(currentTheme, false);

function notify(message) { const n = document.createElement('div'); n.className = 'notice'; n.textContent = message; document.body.append(n); requestAnimationFrame(() => n.classList.add('show')); setTimeout(() => n.remove(), 2800); }
function clock() { document.querySelector('#clock').textContent = new Intl.DateTimeFormat('pt-BR',{weekday:'short',hour:'2-digit',minute:'2-digit'}).format(new Date()); }
setInterval(clock, 1000); clock();

async function setup() {
  currentView = 'setup';
  setGameBackground(null);
  const settings = await window.orbis.settings();
  const palette = Object.entries(XMB_THEMES).map(([name, theme]) =>
    `<button class="theme-swatch ${name === currentTheme ? 'active' : ''}" data-theme="${name}" style="--swatch:${theme.colors[1]}" title="${theme.label}" aria-label="Cor ${theme.label}"></button>`
  ).join('');
  app.innerHTML = `<section class="setup"><h1>Configurações</h1><p>Configure o RPCS3, sua biblioteca, músicas e a cor do XMB.</p><div class="setup-card"><div class="theme-setting"><span>Cor do XMB</span><div class="theme-palette">${palette}</div></div><button id="rpc">Selecionar executável do RPCS3</button><div class="path">${escapeHtml(settings.rpcs3Path || 'Nenhum executável selecionado')}</div><button id="folder">Selecionar pasta dos jogos</button><div class="path">${escapeHtml(settings.gamesPath || 'Nenhuma pasta selecionada')}</div><button id="music">Selecionar pasta de músicas</button><div class="path">${escapeHtml(settings.musicPath || 'Nenhuma pasta selecionada — usando som ambiente')}</div><button id="continue">Entrar na biblioteca</button></div></section>`;
  document.querySelectorAll('.theme-swatch').forEach(swatch => {
    swatch.onclick = () => {
      applyTheme(swatch.dataset.theme);
      playUiSound(600);
    };
  });
  document.querySelector('#rpc').onclick = async () => { await window.orbis.chooseRpcs3(); setup(); };
  document.querySelector('#folder').onclick = async () => { await window.orbis.chooseGames(); setup(); };
  document.querySelector('#music').onclick = async () => {
    const chosen = await window.orbis.chooseMusic();
    if (chosen) await loadMusic();
    setup();
  };
  document.querySelector('#continue').onclick = library;
}

async function library() {
  currentView = 'library';
  games = await window.orbis.games(); selected = 0; renderLibrary();
}

function setGameBackground(game) {
  document.body.style.setProperty('--game-background', game?.background ? `url("${game.background}")` : 'none');
  document.body.classList.toggle('has-game-background', Boolean(game?.background));
}

function renderLibrary() {
  if (!games.length) { setGameBackground(null); app.innerHTML = `<section class="empty"><h1>Nenhum jogo encontrado</h1><p>Adicione jogos à pasta escolhida e atualize a biblioteca.</p><div class="controls"><button id="open">Abrir pasta</button><button id="settings">Configurações</button></div></section>`; document.querySelector('#open').onclick=()=>window.orbis.openFolder(); document.querySelector('#settings').onclick=setup; return; }
  const shown = games.slice(Math.max(0, selected - 2), selected + 3);
  const currentGame = games[selected];
  setGameBackground(currentGame);
  app.innerHTML = `<section class="library"><div class="section-label">BIBLIOTECA</div><div class="game-row">${shown.map(game => { const index=games.indexOf(game); const cover = game.cover ? `<img src="${escapeHtml(game.cover)}" alt="" draggable="false">` : `<div class="cover-placeholder">ORBIS</div>`; return `<article class="game ${index===selected?'active':''}" data-index="${index}" role="button" tabindex="${index === selected ? '0' : '-1'}"><div class="artwork">${cover}</div><span class="title">${escapeHtml(game.title)}</span></article>`; }).join('')}</div></section>`;
  document.querySelectorAll('.game').forEach(el => {
    el.onclick = () => {
      const index = Number(el.dataset.index);
      if (index === selected) return play();
      selected = index;
      renderLibrary();
    };
  });
}
async function play() {
  const result = await window.orbis.launch(games[selected].path);
  if (!result.ok) notify(result.message);
  else {
    pauseMusic();
    notify('Abrindo jogo…');
  }
}

function moveSelection(direction) {
  if (currentView !== 'library' || !games.length) return;
  selected = (selected + direction + games.length) % games.length;
  renderLibrary();
  playUiSound(520);
}

function focusSetupButton(direction) {
  const buttons = [...app.querySelectorAll('button')];
  if (!buttons.length) return;
  const current = buttons.indexOf(document.activeElement);
  const next = current === -1
    ? (direction > 0 ? 0 : buttons.length - 1)
    : (current + direction + buttons.length) % buttons.length;
  buttons[next].focus();
  playUiSound(440);
}

function activatePrimary() {
  ensureAudio();
  playUiSound(720);
  if (currentView === 'library' && games.length) return play();
  const focused = app.querySelector('button:focus') || app.querySelector('button');
  focused?.click();
}

function goBack() {
  ensureAudio();
  playUiSound(330);
  if (currentView === 'library') setup();
  else if (games.length) {
    currentView = 'library';
    renderLibrary();
  }
}

function ensureAudio() {
  if (!audioContext) {
    audioContext = new AudioContext();
    ambientGain = audioContext.createGain();
    ambientGain.gain.value = 0.018;
    ambientGain.connect(audioContext.destination);

    const filter = audioContext.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 850;
    filter.Q.value = 0.7;
    filter.connect(ambientGain);

    [110, 164.81, 220].forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      oscillator.detune.value = index * 4 - 4;
      gain.gain.value = index === 1 ? 0.14 : 0.09;
      oscillator.connect(gain).connect(filter);
      oscillator.start();
    });

    const lfo = audioContext.createOscillator();
    const lfoGain = audioContext.createGain();
    lfo.frequency.value = 0.08;
    lfoGain.gain.value = 0.008;
    lfo.connect(lfoGain).connect(ambientGain.gain);
    lfo.start();
  }
  if (audioContext.state === 'suspended') audioContext.resume();
}

function playRandomMusic() {
  if (!musicTracks.length || musicPausedForGame) return;
  const choices = musicTracks.length > 1
    ? musicTracks.filter(track => track !== currentMusic)
    : musicTracks;
  currentMusic = choices[Math.floor(Math.random() * choices.length)];
  musicPlayer.src = currentMusic;
  musicPlayer.volume = 0.32;
  musicPlayer.play().catch(() => {});
}

function pauseMusic() {
  musicPausedForGame = true;
  musicPlayer.pause();
  if (audioContext && ambientGain) {
    ambientGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.2);
  }
}

function resumeMusic() {
  musicPausedForGame = false;
  ensureAudio();
  if (musicTracks.length) {
    if (musicPlayer.src && !musicPlayer.ended) musicPlayer.play().catch(() => playRandomMusic());
    else playRandomMusic();
    if (ambientGain) ambientGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.2);
  } else if (ambientGain) {
    ambientGain.gain.setTargetAtTime(0.018, audioContext.currentTime, 0.4);
  }
}

async function loadMusic() {
  musicTracks = await window.orbis.music();
  ensureAudio();
  if (!musicTracks.length) {
    musicPlayer.pause();
    currentMusic = '';
    if (!musicPausedForGame) ambientGain.gain.setTargetAtTime(0.018, audioContext.currentTime, 0.4);
    return;
  }
  ambientGain.gain.setTargetAtTime(0, audioContext.currentTime, 0.4);
  if (!musicPausedForGame) playRandomMusic();
}

musicPlayer.addEventListener('ended', () => {
  if (!musicPausedForGame) playRandomMusic();
});

function playUiSound(frequency) {
  if (!audioContext || audioContext.state !== 'running') return;
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, now);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 1.12, now + 0.08);
  gain.gain.setValueAtTime(0.035, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.13);
}

function handleGamepadAction(action) {
  const now = Date.now();
  if (lastControllerAction.action === action && now - lastControllerAction.time < 160) return;
  lastControllerAction = { action, time: now };
  ensureAudio();
  if (action === 'exit') return window.orbis.quit();
  if (action === 'left') moveSelection(-1);
  if (action === 'right') moveSelection(1);
  if (action === 'up') currentView === 'setup' ? focusSetupButton(-1) : playUiSound(440);
  if (action === 'down') currentView === 'setup' ? focusSetupButton(1) : playUiSound(440);
  if (action === 'accept') activatePrimary();
  if (action === 'back') goBack();
  if (action === 'options' && currentView === 'library') setup();
  if (action === 'refresh' && currentView === 'library') library();
}

function pollGamepads() {
  for (const gamepad of navigator.getGamepads()) {
    if (!gamepad) continue;
    const previous = gamepadState.get(gamepad.index) || {};
    const exitCombination = Boolean(gamepad.buttons[8]?.pressed && gamepad.buttons[9]?.pressed);
    const pressed = {
      accept: Boolean(gamepad.buttons[0]?.pressed),
      back: Boolean(gamepad.buttons[1]?.pressed),
      options: Boolean(gamepad.buttons[3]?.pressed),
      exit: exitCombination,
      refresh: Boolean(gamepad.buttons[9]?.pressed && !exitCombination),
      left: Boolean(gamepad.buttons[14]?.pressed || gamepad.axes[0] < -0.55),
      right: Boolean(gamepad.buttons[15]?.pressed || gamepad.axes[0] > 0.55),
      up: Boolean(gamepad.buttons[12]?.pressed || gamepad.axes[1] < -0.55),
      down: Boolean(gamepad.buttons[13]?.pressed || gamepad.axes[1] > 0.55)
    };
    for (const [action, active] of Object.entries(pressed)) {
      if (active && !previous[action]) handleGamepadAction(action);
    }
    gamepadState.set(gamepad.index, pressed);
  }
  requestAnimationFrame(pollGamepads);
}

window.addEventListener('gamepadconnected', event => {
  notify(`Controle conectado: ${event.gamepad.id.split('(')[0].trim()}`);
  ensureAudio();
});
window.addEventListener('gamepaddisconnected', event => gamepadState.delete(event.gamepad.index));
window.orbis.onControllerAction(handleGamepadAction);
window.orbis.onControllerStatus(notify);
window.orbis.onGameStopped(() => {
  resumeMusic();
  notify('De volta ao XMB');
});
window.addEventListener('pointerdown', ensureAudio, { once: true });
window.addEventListener('keydown', e => {
  ensureAudio();
  if (e.ctrlKey && e.key.toLowerCase() === 'q') {
    e.preventDefault();
    return window.orbis.quit();
  }
  if (e.key.toLowerCase() === 'r') return library();
  if (e.key === 'ArrowLeft') moveSelection(-1);
  if (e.key === 'ArrowRight') moveSelection(1);
  if (e.key === 'ArrowUp' && currentView === 'setup') focusSetupButton(-1);
  if (e.key === 'ArrowDown' && currentView === 'setup') focusSetupButton(1);
  if (e.key === 'Enter') activatePrimary();
  if (e.key === 'Escape') goBack();
});

document.querySelector('#header-settings').onclick = () => { ensureAudio(); playUiSound(600); setup(); };

function playBootSound() {
  ensureAudio();
  const now = audioContext.currentTime;
  const master = audioContext.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(0.24, now + 3.0);
  master.gain.setValueAtTime(0.24, now + 4.4);
  master.gain.exponentialRampToValueAtTime(0.0001, now + 7.4);
  master.connect(audioContext.destination);

  // Acorde em quintas (G), som de "orquestra crescendo" como no boot do PS3.
  const partials = [
    { frequency: 98,     level: 0.50 },
    { frequency: 146.83, level: 0.34 },
    { frequency: 196,    level: 0.44 },
    { frequency: 293.66, level: 0.20 },
    { frequency: 392,    level: 0.13 },
    { frequency: 587.33, level: 0.07 }
  ];
  partials.forEach((partial, index) => {
    for (const detune of [-4, 3]) {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      oscillator.type = index < 2 ? 'sine' : 'triangle';
      oscillator.frequency.value = partial.frequency;
      oscillator.detune.value = detune + index;
      gain.gain.value = partial.level * 0.5;
      oscillator.connect(gain).connect(master);
      oscillator.start(now);
      oscillator.stop(now + 7.6);
    }
  });
}

async function boot() {
  const bootScreen = document.getElementById('boot');
  playBootSound();
  await library();
  setGameBackground(null);
  setTimeout(() => {
    bootScreen.classList.add('fade-out');
    document.body.classList.remove('booting');
    setTimeout(() => {
      bootScreen.remove();
      if (games.length) setGameBackground(games[selected]);
      loadMusic();
    }, 1300);
  }, 5200);
}

requestAnimationFrame(pollGamepads);
ensureAudio();
boot();
