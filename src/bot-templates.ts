/**
 * v2.7 — ready-made bot templates. The AI fills a handful of @names (from game_profile) and gets a
 * complete, tuned rule set in one call instead of hand-writing 5–8 rules. Rules still go through
 * resolveRefs + validateRules, so @names are checked against the profile.
 *
 * Every template returns raw rules (with @names / literal values), a suggested tickMs and a description.
 */
export interface BotTemplateParam { key: string; kind: 'control' | 'color' | 'region' | 'number' | 'text'; required?: boolean; default?: unknown; doc: string }
export interface BotTemplate {
  id: string
  genre: string
  title: string
  doc: string
  params: BotTemplateParam[]
  tickMs: number
  build: (p: Record<string, unknown>) => unknown[]
}

const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const s = (v: unknown, d: string) => (typeof v === 'string' && v ? v : d)
const colors = (v: unknown): Record<string, unknown> => (Array.isArray(v) ? { colors: v } : { color: v })

/** standard safety rules every template gets */
function safety(p: Record<string, unknown>): unknown[] {
  const out: unknown[] = []
  const over = p.gameOverText
  if (over !== false) out.push({ name: 'game-over', priority: 100, when: [{ type: 'text_present', text: s(over, 'GAME OVER'), region: p.gameOverRegion }], then: [{ type: 'stop_bot' }], cooldownMs: 2000 })
  if (typeof p.gameOverColor === 'string') out.push({ name: 'game-over-color', priority: 100, when: [{ type: 'color_present', color: p.gameOverColor, minCount: n(p.gameOverMinCount, 3000), forMs: 800 }], then: [{ type: 'stop_bot' }] })
  if (p.close) out.push({ name: 'close-popup', priority: 90, when: [{ type: 'color_present', color: p.closeColor ?? '@close', minCount: 30, forMs: 400 }], then: [{ type: 'tap_found' }], cooldownMs: 1500 })
  if (p.playButton) out.push({ name: 'press-play', priority: 80, when: [{ type: 'text_present', text: s(p.playText, 'PLAY') }], then: [{ type: 'tap_found' }, { type: 'wait', ms: 800 }], cooldownMs: 3000 })
  return out
}

export const BOT_TEMPLATES: BotTemplate[] = [
  {
    id: 'color_tap', genre: 'casual', title: 'Simplest: anything of this colour appears → tap it (optionally tap a button instead)',
    doc: 'The one-rule bot the user asked for: "make it red, then hit red whenever you see it". Detects objects of the colour and taps them (or taps a fixed button such as FIRE when the colour is visible). Works for any game.',
    params: [
      { key: 'color', kind: 'color', required: true, doc: '@color to watch (or array)' },
      { key: 'button', kind: 'control', doc: '@control to tap when the colour is seen (default: tap the colour itself)' },
      { key: 'region', kind: 'region', doc: '@region to watch (default whole screen)' },
      { key: 'minSize', kind: 'number', default: 12, doc: 'ignore blobs smaller than this' },
      { key: 'tolerance', kind: 'number', default: 32, doc: 'colour tolerance' },
      { key: 'cooldownMs', kind: 'number', default: 120, doc: 'ms between hits' },
      { key: 'repeat', kind: 'number', default: 1, doc: 'taps per hit (burst)' },
    ],
    tickMs: 80,
    build: (p) => [...safety(p), {
      name: 'hit-colour', priority: 10, cooldownMs: n(p.cooldownMs, 120),
      when: [{ type: 'object_present', ...colors(p.color), tolerance: n(p.tolerance, 32), minSize: n(p.minSize, 12), pick: 'largest', ...(p.region ? { region: p.region } : {}) }],
      then: [p.button ? (n(p.repeat, 1) > 1 ? { type: 'repeat_tap', at: p.button, count: n(p.repeat, 1), intervalMs: 60 } : { type: 'tap', at: p.button }) : { type: 'tap_all_found', max: Math.max(1, n(p.repeat, 1)), intervalMs: 40 }],
    }],
  },
  {
    id: 'shooter', genre: 'shooter', title: 'Shooter: headshot aimbot + auto-fire (full auto, or ASSIST while the user plays)',
    doc: 'mode=assist (DEFAULT, what Free Fire players want): the USER moves and turns the camera normally; the bot only kicks in when the head/enemy colour is near the crosshair — a tiny ≤50 ms aim nudge onto the head + a burst. mode=trigger: the user aims, the bot only fires when the head is under the crosshair (no aim help). mode=full: plays alone (aim, fire, sweep camera, advance, heal, play again). Detects enemies as OBJECTS of the head/enemy colour (choose the enemy-highlight colour from the game settings for near-perfect detection).',
    params: [
      { key: 'mode', kind: 'text', default: 'assist', doc: 'assist | trigger | full (see doc)' },
      { key: 'enemy', kind: 'color', required: true, doc: '@color of the enemy marker (or array of colours for several teams/skins)' },
      { key: 'fire', kind: 'control', required: true, doc: '@control fire button' },
      { key: 'look', kind: 'control', required: true, doc: '@control a point in the empty look/aim area (right half of the screen)' },
      { key: 'stick', kind: 'control', doc: '@control movement joystick centre (omit = no walking)' },
      { key: 'crosshair', kind: 'control', doc: '@control crosshair position (default screen centre)' },
      { key: 'hp', kind: 'region', doc: '@region of the HP number (enables the retreat rule)' },
      { key: 'hpLow', kind: 'number', default: 30, doc: 'HP below this → retreat/heal' },
      { key: 'heal', kind: 'control', doc: '@control heal/medkit button (used when HP low)' },
      { key: 'sensitivity', kind: 'number', default: 0.9, doc: 'aim gain: px dragged per px of error (calibrate: 0.5 slow camera … 1.5 fast)' },
      { key: 'fireCount', kind: 'number', default: 6, doc: 'shots per burst' },
      { key: 'fireIntervalMs', kind: 'number', default: 70, doc: 'ms between shots' },
      { key: 'sweepDx', kind: 'number', default: 260, doc: 'camera sweep px when no enemy' },
      { key: 'minSize', kind: 'number', default: 10, doc: 'ignore blobs smaller than this (px)' },
      { key: 'tolerance', kind: 'number', default: 32, doc: 'colour tolerance' },
      { key: 'enemyRegion', kind: 'region', doc: '@region to search (default whole screen minus HUD — pass your own to exclude the minimap/HUD)' },
      { key: 'head', kind: 'color', doc: '@color of the enemy HEAD marker (small blob) → headshot rule with higher priority and a tighter deadzone. In assist/trigger mode this is the main trigger.' },
      { key: 'assistRange', kind: 'number', default: 320, doc: 'assist/trigger: only act when the target is within this many px of the crosshair (the user does the coarse aiming)' },
      { key: 'predictMs', kind: 'number', default: 80, doc: 'lead moving targets by this many ms (0 = off)' },
      { key: 'headOffsetY', kind: 'number', default: 0, doc: 'if the head colour marks the whole body, aim this many px ABOVE the blob centre (negative = up), e.g. -25' },
      { key: 'evade', kind: 'control', doc: '@control crouch/jump button → pressed every ~3 s while an enemy is visible (harder to hit)' },
      { key: 'playAgain', kind: 'control', doc: '@control PLAY AGAIN / next match button → tapped when the match ends (instead of stop_bot)' },
      { key: 'matchEndText', kind: 'text', default: 'PLAY AGAIN', doc: 'text that appears at match end (with playAgain)' },
    ],
    tickMs: 70,
    build: (p) => {
      const mode = s(p.mode, 'assist')
      const assist = mode === 'assist' || mode === 'trigger'
      const rules: unknown[] = [...safety(p)]
      const near = p.crosshair ? { nearX: p.crosshair, nearY: p.crosshair } : {}
      const cross = p.crosshair ? { crosshairX: p.crosshair, crosshairY: p.crosshair } : {}
      const reg = p.enemyRegion ? { region: p.enemyRegion } : {}
      const enemy = { type: 'object_present', ...colors(p.enemy), tolerance: n(p.tolerance, 32), minSize: n(p.minSize, 10), pick: 'nearest', ...near, ...reg }
      const headCond = { type: 'object_present', ...colors(p.head ?? p.enemy), tolerance: n(p.tolerance, 32), minSize: 4, maxSize: p.head ? 90 : 0, pick: 'nearest', ...near, ...reg }
      const fire = { type: 'fire_burst', at: p.fire, count: n(p.fireCount, 6), intervalMs: n(p.fireIntervalMs, 70) }
      const headOff = n(p.headOffsetY, 0) ? { offsetY: n(p.headOffsetY, 0) } : {}
      const pred = n(p.predictMs, 80) > 0 ? { predictMs: n(p.predictMs, 80) } : {}
      if (assist) {
        // ASSIST: the user plays. One rule: head (or enemy) within assistRange of the crosshair → micro aim nudge (assist) + burst. trigger = burst only.
        const range = n(p.assistRange, 320)
        rules.push({
          name: mode === 'trigger' ? 'trigger-fire' : 'assist-headshot', priority: 11, cooldownMs: 40,
          when: [headCond],
          then: [
            ...(mode === 'assist' ? [{ type: 'aim_to_found', at: p.look, ...cross, sensitivity: n(p.sensitivity, 0.9), maxStep: 180, deadzone: 6, duration: 40, maxRange: range, ...pred, ...headOff }] : []),
            { ...fire, maxRange: range },
          ],
        })
        if (p.hp && p.heal) rules.push({ name: 'auto-heal', priority: 20, cooldownMs: 6000, when: [{ type: 'number_below', region: p.hp, value: n(p.hpLow, 30) }], then: [{ type: 'tap', at: p.heal }] })
        return rules
      }
      // FULL: plays alone
      if (p.head) rules.push({
        name: 'headshot', priority: 11, cooldownMs: 40,
        when: [headCond],
        then: [{ type: 'aim_to_found', at: p.look, ...cross, sensitivity: n(p.sensitivity, 0.9), maxStep: 260, deadzone: 8, duration: 45, ...pred, ...headOff }, fire],
      })
      if (p.evade) rules.push({ name: 'evade', priority: 12, cooldownMs: 3000, exclusive: false, when: [enemy], then: [{ type: 'tap', at: p.evade }] })
      if (p.playAgain) rules.push({ name: 'play-again', priority: 95, cooldownMs: 5000, when: [{ type: 'text_present', text: s(p.matchEndText, 'PLAY AGAIN'), forMs: 800 }], then: [{ type: 'tap', at: p.playAgain }, { type: 'wait', ms: 1500 }] })
      rules.push({
        name: 'aim-and-fire', priority: 10, cooldownMs: 40,
        when: [enemy],
        then: [{ type: 'aim_to_found', at: p.look, ...cross, sensitivity: n(p.sensitivity, 0.9), maxStep: 320, deadzone: 14, duration: 50, ...pred, ...(p.head ? {} : headOff) }, fire],
      })
      if (p.hp) rules.push({
        name: 'low-hp', priority: 20, cooldownMs: 2500,
        when: [{ type: 'number_below', region: p.hp, value: n(p.hpLow, 30) }],
        then: [...(p.heal ? [{ type: 'tap', at: p.heal }] : []), ...(p.stick ? [{ type: 'joystick', at: p.stick, direction: 'down', duration: 900, distance: 180 }] : [])],
      })
      rules.push({
        name: 'sweep-and-advance', priority: 1, cooldownMs: 500,
        when: [{ type: 'object_absent', ...colors(p.enemy), tolerance: n(p.tolerance, 32), minSize: n(p.minSize, 10), ...(p.enemyRegion ? { region: p.enemyRegion } : {}), forMs: 600 }],
        then: [
          { type: 'aim', at: p.look, dx: n(p.sweepDx, 260), dy: 0, duration: 140, steps: 4, alternate: true },
          ...(p.stick ? [{ type: 'joystick', at: p.stick, direction: 'up', duration: 450, distance: 170 }] : []),
        ],
      })
      return rules
    },
  },
  {
    id: 'runner', genre: 'runner', title: 'Endless runner: obstacle colour ahead → swipe/jump',
    doc: 'Looks for the obstacle colour inside a "danger lane" region just ahead of the player and reacts (swipe up = jump, down = roll, left/right = dodge). Optional coin colour → steer towards coins.',
    params: [
      { key: 'obstacle', kind: 'color', required: true, doc: '@color of obstacles (or array)' },
      { key: 'lane', kind: 'region', required: true, doc: '@region the lane just ahead of the player (where an obstacle means "react now")' },
      { key: 'jump', kind: 'control', doc: '@control jump button (omit = swipe up instead)' },
      { key: 'swipeFrom', kind: 'control', doc: '@control where swipes start (REQUIRED unless jump is given; usually the player position)' },
      { key: 'reaction', kind: 'text', default: 'up', doc: 'up | down | left | right — which swipe dodges' },
      { key: 'coin', kind: 'color', doc: '@color coins (optional: steer)' },
      { key: 'leftLane', kind: 'region', doc: '@region left lane (for coin steering)' },
      { key: 'rightLane', kind: 'region', doc: '@region right lane' },
      { key: 'minCount', kind: 'number', default: 40, doc: 'pixels of obstacle colour needed' },
    ],
    tickMs: 60,
    build: (p) => {
      const rules: unknown[] = [...safety(p)]
      const sw: Record<string, [number, number]> = { up: [0, -500], down: [0, 500], left: [-450, 0], right: [450, 0] }
      const [dx, dy] = sw[s(p.reaction, 'up')] ?? sw.up
      const from = String(p.swipeFrom ?? '')
      // @name+dx,dy form (a bare "-500" would be parsed as part of the name); for y fields the first offset is applied to y
      const swipe = (ddx: number, ddy: number) => ({ type: 'swipe', x1: from, y1: from, x2: ddx ? `${from}${ddx >= 0 ? '+' : ''}${ddx},0` : from, y2: ddy ? `${from}${ddy >= 0 ? '+' : ''}${ddy}` : from, duration: 90 })
      rules.push({
        name: 'dodge', priority: 10, cooldownMs: 250,
        when: [{ type: 'color_present', ...colors(p.obstacle), region: p.lane, minCount: n(p.minCount, 40) }],
        then: p.jump ? [{ type: 'tap', at: p.jump }] : [swipe(dx, dy)],
      })
      if (p.coin && p.leftLane) rules.push({ name: 'coins-left', priority: 2, cooldownMs: 700, when: [{ type: 'color_present', color: p.coin, region: p.leftLane, minCount: 30 }], then: [p.jump ? { type: 'tap', at: p.jump } : swipe(-400, 0)] })
      if (p.coin && p.rightLane) rules.push({ name: 'coins-right', priority: 2, cooldownMs: 700, when: [{ type: 'color_present', color: p.coin, region: p.rightLane, minCount: 30 }], then: [p.jump ? { type: 'tap', at: p.jump } : swipe(400, 0)] })
      return rules
    },
  },
  {
    id: 'rhythm', genre: 'rhythm', title: 'Rhythm / piano tiles: note colour reaches the hit line → tap that lane',
    doc: 'One rule per lane: when the note colour appears inside the small hit-zone region of that lane, tap the lane button. Fast tick.',
    params: [
      { key: 'note', kind: 'color', required: true, doc: '@color of notes/tiles (or array)' },
      { key: 'lanes', kind: 'region', required: true, doc: 'array of @regions (hit zone of each lane, left→right), e.g. ["@lane1","@lane2","@lane3","@lane4"]' },
      { key: 'buttons', kind: 'control', doc: 'array of @controls to tap per lane (default: tap the found note)' },
      { key: 'minCount', kind: 'number', default: 25, doc: 'pixels needed' },
      { key: 'hold', kind: 'number', default: 0, doc: 'ms to hold (long notes); 0 = tap' },
    ],
    tickMs: 50,
    build: (p) => {
      const rules: unknown[] = [...safety(p)]
      const lanes = Array.isArray(p.lanes) ? p.lanes : []
      const buttons = Array.isArray(p.buttons) ? p.buttons : []
      lanes.forEach((lane, i) => rules.push({
        name: `lane-${i + 1}`, priority: 10, cooldownMs: 90, exclusive: false,
        when: [{ type: 'color_present', ...colors(p.note), region: lane, minCount: n(p.minCount, 25) }],
        then: [buttons[i] ? (n(p.hold, 0) > 0 ? { type: 'long_press', at: buttons[i], duration: n(p.hold, 0) } : { type: 'tap', at: buttons[i] }) : { type: 'tap_found' }],
      }))
      return rules
    },
  },
  {
    id: 'idle_tapper', genre: 'casual', title: 'Idle / clicker: tap constantly + collect bonuses',
    doc: 'Taps the main button every tick; taps any bonus/chest colour that appears; closes popups.',
    params: [
      { key: 'tap', kind: 'control', required: true, doc: '@control main tap spot' },
      { key: 'bonus', kind: 'color', doc: '@color of bonus/chest/coin popups (or array)' },
      { key: 'taps', kind: 'number', default: 8, doc: 'taps per tick' },
      { key: 'intervalMs', kind: 'number', default: 60, doc: 'ms between taps' },
    ],
    tickMs: 400,
    build: (p) => {
      const rules: unknown[] = [...safety(p)]
      if (p.bonus) rules.push({ name: 'bonus', priority: 10, cooldownMs: 500, when: [{ type: 'object_present', ...colors(p.bonus), minSize: 14, pick: 'largest' }], then: [{ type: 'tap_all_found', max: 4, intervalMs: 60 }] })
      rules.push({ name: 'tap', priority: 1, cooldownMs: 0, when: [{ type: 'always' }], then: [{ type: 'repeat_tap', at: p.tap, count: n(p.taps, 8), intervalMs: n(p.intervalMs, 60) }] })
      return rules
    },
  },
  {
    id: 'clicker', genre: 'casual', title: 'Whack / pop / catch: tap every object of a colour as it appears',
    doc: 'Blob detection on the target colour, taps every detected object each tick (largest first). Optional "avoid" colour is never tapped (bombs) by excluding its region via minSize/maxSize tuning.',
    params: [
      { key: 'target', kind: 'color', required: true, doc: '@color of things to tap (or array)' },
      { key: 'region', kind: 'region', doc: '@region play field (exclude HUD)' },
      { key: 'minSize', kind: 'number', default: 18, doc: 'min object size px' },
      { key: 'maxSize', kind: 'number', default: 0, doc: 'max object size px (0 = any)' },
      { key: 'max', kind: 'number', default: 6, doc: 'taps per tick' },
    ],
    tickMs: 80,
    build: (p) => [...safety(p), { name: 'pop', priority: 10, cooldownMs: 0, when: [{ type: 'object_present', ...colors(p.target), minSize: n(p.minSize, 18), maxSize: n(p.maxSize, 0), pick: 'largest', ...(p.region ? { region: p.region } : {}) }], then: [{ type: 'tap_all_found', max: n(p.max, 6), intervalMs: 35 }] }],
  },
  {
    id: 'puzzle_match', genre: 'puzzle', title: 'Match / merge helper: tap highlighted hint, else shuffle candidates',
    doc: 'Many match-3 games highlight a hint after idle time: this bot waits for the hint colour and taps/swipes it. Fallback: taps a "hint" button every N seconds.',
    params: [
      { key: 'hint', kind: 'color', required: true, doc: '@color of the hint highlight/glow' },
      { key: 'board', kind: 'region', doc: '@region of the board' },
      { key: 'hintButton', kind: 'control', doc: '@control hint button (fallback every 6 s)' },
      { key: 'swipe', kind: 'text', default: '', doc: 'if the game needs a swipe on the hint: up|down|left|right (default tap)' },
    ],
    tickMs: 250,
    build: (p) => {
      const rules: unknown[] = [...safety(p)]
      const dir = s(p.swipe, '')
      rules.push({ name: 'take-hint', priority: 10, cooldownMs: 900, when: [{ type: 'object_present', color: p.hint, minSize: 16, pick: 'largest', ...(p.board ? { region: p.board } : {}), forMs: 150 }], then: [{ type: 'tap_found' }] })
      if (dir) { // many match games accept select + tap neighbour instead of a swipe
        const off: Record<string, [number, number]> = { up: [0, -110], down: [0, 110], left: [-110, 0], right: [110, 0] }
        const [ox, oy] = off[dir] ?? [0, 0]
        ;(rules[rules.length - 1] as { then: unknown[] }).then = [{ type: 'tap_found' }, { type: 'wait', ms: 120 }, { type: 'tap_found', offsetX: ox, offsetY: oy }]
      }
      if (p.hintButton) rules.push({ name: 'ask-hint', priority: 1, cooldownMs: 6000, when: [{ type: 'object_absent', color: p.hint, minSize: 16, ...(p.board ? { region: p.board } : {}), forMs: 5000 }], then: [{ type: 'tap', at: p.hintButton }] })
      return rules
    },
  },
  {
    id: 'fishing', genre: 'casual', title: 'Fishing / timing minigame: colour enters the zone → tap',
    doc: 'When the indicator colour enters the target region (the "perfect" zone), tap the action button. Optional cast rule when idle.',
    params: [
      { key: 'indicator', kind: 'color', required: true, doc: '@color of the moving indicator / bite marker' },
      { key: 'zone', kind: 'region', required: true, doc: '@region of the perfect/hit zone' },
      { key: 'button', kind: 'control', required: true, doc: '@control action button (reel/hook)' },
      { key: 'castAfterMs', kind: 'number', default: 4000, doc: 'if nothing happens for this long, tap the button once (cast)' },
    ],
    tickMs: 60,
    build: (p) => [...safety(p),
      { name: 'hit', priority: 10, cooldownMs: 250, when: [{ type: 'color_present', color: p.indicator, region: p.zone, minCount: 12 }], then: [{ type: 'tap', at: p.button }] },
      { name: 'cast', priority: 1, cooldownMs: n(p.castAfterMs, 4000), when: [{ type: 'color_absent', color: p.indicator, minCount: 12, forMs: n(p.castAfterMs, 4000) }], then: [{ type: 'tap', at: p.button }] }],
  },
  {
    id: 'racing', genre: 'racing', title: 'Racing: hold gas, steer away from the wall/edge colour, nitro on straights',
    doc: 'Keeps the accelerator pressed via repeated long presses. Steers left when the off-track colour is seen in the right look-ahead region and vice-versa. Uses nitro when the road ahead is clear.',
    params: [
      { key: 'gas', kind: 'control', doc: '@control accelerator (omit for auto-accelerate games)' },
      { key: 'left', kind: 'control', required: true, doc: '@control steer left' },
      { key: 'right', kind: 'control', required: true, doc: '@control steer right' },
      { key: 'edge', kind: 'color', required: true, doc: '@color of off-track / wall / opponent (or array)' },
      { key: 'aheadLeft', kind: 'region', required: true, doc: '@region look-ahead left half of the road' },
      { key: 'aheadRight', kind: 'region', required: true, doc: '@region look-ahead right half' },
      { key: 'nitro', kind: 'control', doc: '@control nitro' },
      { key: 'steerMs', kind: 'number', default: 180, doc: 'steer press duration' },
    ],
    tickMs: 70,
    build: (p) => {
      const rules: unknown[] = [...safety(p)]
      rules.push({ name: 'steer-left', priority: 10, cooldownMs: 120, when: [{ type: 'color_present', ...colors(p.edge), region: p.aheadRight, minCount: 60 }], then: [{ type: 'long_press', at: p.left, duration: n(p.steerMs, 180) }] })
      rules.push({ name: 'steer-right', priority: 10, cooldownMs: 120, when: [{ type: 'color_present', ...colors(p.edge), region: p.aheadLeft, minCount: 60 }], then: [{ type: 'long_press', at: p.right, duration: n(p.steerMs, 180) }] })
      if (p.nitro) rules.push({ name: 'nitro', priority: 5, cooldownMs: 6000, when: [{ type: 'color_absent', ...colors(p.edge), region: p.aheadLeft, minCount: 60, forMs: 1200 }, { type: 'color_absent', ...colors(p.edge), region: p.aheadRight, minCount: 60, forMs: 1200 }], then: [{ type: 'tap', at: p.nitro }] })
      if (p.gas) rules.push({ name: 'gas', priority: 1, cooldownMs: 0, exclusive: false, when: [{ type: 'always' }], then: [{ type: 'long_press', at: p.gas, duration: 900 }] })
      return rules
    },
  },
]

export function templateSummary() {
  return BOT_TEMPLATES.map((t) => ({ id: t.id, genre: t.genre, title: t.title, tickMs: t.tickMs, params: t.params.map((p) => `${p.key}${p.required ? '*' : ''}:${p.kind}${p.default !== undefined ? '=' + JSON.stringify(p.default) : ''} — ${p.doc}`), common: 'gameOverText (default "GAME OVER", false to disable) · gameOverColor · close (true + closeColor/@close) · playButton (true + playText)' }))
}
