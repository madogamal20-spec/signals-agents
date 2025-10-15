const fs = require('fs');
const axios = require('axios');
const ti = require('technicalindicators');

const T = JSON.parse(fs.readFileSync('thresholds.json'));
const W = JSON.parse(fs.readFileSync('weights.json'));
const STATE = JSON.parse(fs.readFileSync('state.json'));

async function fetchOHLC(pair, interval = '5m', limit = 200) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`;
  const { data } = await axios.get(url);
  return data.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
}

function computeIndicators(c) {
  const closes = c.map(x => x.c);
  const highs  = c.map(x => x.h);
  const lows   = c.map(x => x.l);
  return {
    emaFast: ti.EMA.calculate({ period: T.ema_fast, values: closes }),
    emaSlow: ti.EMA.calculate({ period: T.ema_slow, values: closes }),
    rsi:     ti.RSI.calculate({ period: 14, values: closes }),
    bb:      ti.BollingerBands.calculate({ period: 20, values: closes, stdDev: T.bb_mult }),
    atr:     ti.ATR.calculate({ period: 14, high: highs, low: lows, close: closes })
  };
}

function primarySignal(f) {
  const n = Math.min(f.emaFast.length, f.emaSlow.length, f.rsi.length, f.bb.length, f.atr.length);
  const i = n - 1;
  const last = {
    emaFast: f.emaFast[i],
    emaSlow: f.emaSlow[i],
    rsi:     f.rsi[i],
    bbMid:   f.bb[i] ? f.bb[i].middle : undefined,
    atr:     f.atr[i]
  };
  const dirBuy  = last.emaFast > last.emaSlow && last.rsi > T.rsi_buy  && last.bbMid !== undefined;
  const dirSell = last.emaFast < last.emaSlow && last.rsi < T.rsi_sell && last.bbMid !== undefined;
  let score = 0;
  if (dirBuy || dirSell) score += (W.indicators.EMA + W.indicators.RSI + W.indicators.BOLL);
  return { dir: dirBuy ? 'BUY' : dirSell ? 'SELL' : 'HOLD', score, last };
}

function adaptiveConfidence(base, ok) {
  let conf = base;
  if (!ok.spread || !ok.vol || !ok.atr) conf *= 0.5;
  return Math.max(0, Math.min(1, conf));
}

async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat  = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chat,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

(async () => {
  const results = [];
  for (const pair of T.pairs) {
    const c5  = await fetchOHLC(pair, '5m');
    const c15 = await fetchOHLC(pair, '15m');
    const s5  = primarySignal(computeIndicators(c5));
    const s15 = primarySignal(computeIndicators(c15));
    const agree = (s5.dir === s15.dir) && s5.dir !== 'HOLD';
    const base  = (s5.score + s15.score) / 2;
    const ok    = { spread: true, vol: true, atr: (s5.last.atr || 0) >= T.atr_low_cut };
    const conf  = adaptiveConfidence(base, ok);
    if (agree && conf >= T.confidence_min) {
      results.push({ pair, dir: s5.dir, conf, meta: { s5, s15 } });
    }
  }
  if (results.length) {
    for (const r of results) {
      const msg =
        "[Actions] ✨ إشارة قوية
" +
        "🟢━━━━━━━━━━━━━━━━
" +
        `${r.pair}: ${r.dir}
` +
        `الثقة: ${(r.conf * 100).toFixed(1)}%
` +
        "🟢━━━━━━━━━━━━━━━━";
      await notify(msg);
    }
  }
  STATE.last_signals = results;
  fs.writeFileSync('state.json', JSON.stringify(STATE, null, 2));
})();
