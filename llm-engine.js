const LLMEngine = {
  SUMMARIES: [
    'The market is showing signs of momentum that align with the broader trend.',
    'Current market conditions suggest a period of consolidation before the next move.',
    'Technical indicators present a mixed picture, warranting a cautious approach.',
    'The asset is reacting to recent volatility with increased buyer interest.',
    'Market structure remains intact with healthy pullback and support levels holding.',
  ],

  analyze(data) {
    const {
      symbol = 'BTC',
      price = 0,
      rsi = 50,
      bbPosition = 'within bands',
      momentum = 0,
      prediction = 0,
      accuracy = 50,
      portfolioUSD = 10000,
      pnl = 0,
    } = data;

    const rsiWeight = (rsi - 50) / 50;
    const predWeight = Math.max(-1, Math.min(1, prediction * 5));
    const momentumNorm = momentum / 5;
    const composite = rsiWeight * 0.4 + predWeight * 0.4 + momentumNorm * 0.2;

    let signal;
    let rawConfidence;

    if (composite > 0.15) {
      signal = 'BULLISH';
      rawConfidence = Math.min(0.95, 0.5 + Math.abs(composite) * 0.5);
    } else if (composite < -0.15) {
      signal = 'BEARISH';
      rawConfidence = Math.min(0.95, 0.5 + Math.abs(composite) * 0.5);
    } else {
      signal = 'NEUTRAL';
      rawConfidence = 0.3 + Math.abs(composite) * 0.4;
    }

    const confidence = rawConfidence * 0.6 + (accuracy / 100) * 0.4;

    const summary = this._buildSummary(momentum, rsi, symbol);
    const reasoning = this._buildReasoning(price, rsi, bbPosition, prediction, accuracy, momentum, portfolioUSD, pnl);
    const risks = this._buildRisks(rsi, momentum, accuracy);

    return {
      signal,
      confidence: Math.min(1, Math.max(0, confidence)),
      summary,
      reasoning,
      risks,
      composite,
    };
  },

  _buildSummary(momentum, rsi, symbol) {
    if (momentum > 3) {
      return 'Strong upward momentum detected with RSI at ' + rsi.toFixed(0) + '.';
    } else if (momentum < -3) {
      return 'Downward pressure intensifying \u2014 ' + symbol + ' testing key support levels.';
    } else if (rsi > 70) {
      return 'Overbought conditions at RSI ' + rsi.toFixed(0) + ' \u2014 caution warranted.';
    } else if (rsi < 30) {
      return 'Oversold territory at RSI ' + rsi.toFixed(0) + ' \u2014 potential reversal setup.';
    } else {
      return this.SUMMARIES[Math.floor(Math.random() * this.SUMMARIES.length)];
    }
  },

  _buildReasoning(price, rsi, bbPosition, prediction, accuracy, momentum, portfolioUSD, pnl) {
    const lines = [];
    const curSym = getCurrency ? getCurrency().symbol : '$';
    lines.push('\u2022 Price: ' + curSym + price.toFixed(2) + ' | RSI: ' + rsi.toFixed(0) + ' | Position: ' + bbPosition);

    if (Math.abs(prediction) > 0.05) {
      lines.push('\u2022 Neural net predicts ' + (prediction > 0 ? 'upward' : 'downward') + ' movement (' + (prediction >= 0 ? '+' : '') + prediction.toFixed(4) + ') with ' + accuracy.toFixed(0) + '% historical accuracy.');
    }

    if (Math.abs(momentum) > 2) {
      lines.push('\u2022 Short-term momentum is ' + (momentum > 0 ? 'positive' : 'negative') + ' at ' + (momentum >= 0 ? '+' : '') + momentum.toFixed(2) + '%.');
    }

    const portStr = portfolioUSD > 0 ? curSym + portfolioUSD.toFixed(0) : 'minimal';
    lines.push('\u2022 Portfolio exposure: ' + portStr + ' USD | Unrealized P&L: ' + (pnl >= 0 ? '+' : '') + pnl.toFixed(2) + '%');

    return lines;
  },

  _buildRisks(rsi, momentum, accuracy) {
    const risks = [];
    if (rsi > 65) risks.push('Overbought RSI risk \u2014 potential mean reversion');
    if (rsi < 35) risks.push('Oversold conditions \u2014 trend may persist before reversal');
    if (Math.abs(momentum) > 5) risks.push('High momentum \u2014 increased slippage and volatility risk');
    if (accuracy < 40) risks.push('Reduced model confidence \u2014 NN accuracy below 40%');
    if (risks.length === 0) {
      risks.push('Normal market conditions \u2014 monitor for trend shifts');
    }
    return risks;
  },
};
