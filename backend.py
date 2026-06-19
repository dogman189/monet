"""
ultraexchange - Python Trading Engine
Flask REST + SSE backend. Electron spawns this process on startup.

Math Engine v4 — Deep Neural Network:
  - RSI confirmation filter (configurable period)
  - Band re-entry signals with Bollinger Bands
  - Multi-layer Neural Network (8 features → 16 → 8 → 4 → 1)
  - Xavier weight initialization, ReLU hidden layers, tanh output
  - Online backpropagation with gradient clipping
  - 8 engineered features: RSI, BB position, bandwidth, momentum,
    volatility, price/SMA ratio, consecutive direction, mean reversion
  - Percentage-based or fixed position sizing
  - Bandwidth squeeze filter
  - Configurable trailing stop-loss
"""

import json
import ssl
import math
import random
import urllib.parse
import urllib.request
import certifi
import time
import statistics
import os
import queue
import threading
from collections import deque
from flask import Flask, Response, jsonify, request
from flask_cors import CORS

# ── DATA EXPORT CONFIG ────────────────────────────────────────────────────────
DATA_EXPORT_FILE = "trading_data.json"  
EXPORT_ON_START = True                   
EXPORT_ON_STOP = True                    
EXPORT_INTERVAL = 60                     

app = Flask(__name__)
CORS(app)

# ── CONFIG CONSTANTS & DEFAULTS ───────────────────────────────────────────────

DEFAULT_RSI_PERIOD     = 14
DEFAULT_RSI_OVERSOLD   = 35
DEFAULT_RSI_OVERBOUGHT = 65
DEFAULT_BB_WINDOW      = 20
DEFAULT_BB_STDDEV      = 2.0
MIN_BANDWIDTH          = 0.0002
SELL_PCT               = 0.50
TRADE_COOLDOWN         = 3

# ── NEURAL NETWORK ────────────────────────────────────────────────────────────

class NeuralNetwork:
    """Multi-layer feedforward neural network with online backpropagation.

    Architecture: input → hidden1 (ReLU) → hidden2 (ReLU) → hidden3 (ReLU) → output (tanh)
    Training:     SGD with per-sample backprop + gradient clipping
    Init:         Xavier / He initialization
    """

    def __init__(self, layer_sizes, learning_rate=0.005):
        self.layer_sizes = list(layer_sizes)     # e.g. [8, 16, 8, 4, 1]
        self.lr = learning_rate
        self.weights = []
        self.biases = []
        self.v_weights = []
        self.v_biases = []
        self.momentum = 0.9
        # Xavier / He init
        for i in range(len(layer_sizes) - 1):
            fan_in  = layer_sizes[i]
            fan_out = layer_sizes[i + 1]
            std = math.sqrt(2.0 / fan_in)  # He init for ReLU
            w = [[random.gauss(0, std) for _ in range(fan_out)] for _ in range(fan_in)]
            b = [0.0] * fan_out
            self.weights.append(w)
            self.biases.append(b)
            self.v_weights.append([[0.0] * fan_out for _ in range(fan_in)])
            self.v_biases.append([0.0] * fan_out)
        # Tracking
        self.predictions_made   = 0
        self.correct_directions = 0
        self.accuracy           = 0.0
        self.last_prediction    = 0.0
        self.last_activations   = None
        self.last_price         = None
        self.train_loss         = 0.0

    # ── Activations ───────────────────────────────────────────────────────
    @staticmethod
    def _relu(x):
        return max(0.0, x)

    @staticmethod
    def _relu_deriv(x):
        return 1.0 if x > 0 else 0.0

    @staticmethod
    def _tanh(x):
        x = max(-10.0, min(10.0, x))  # clamp to avoid overflow
        return math.tanh(x)

    @staticmethod
    def _tanh_deriv(output):
        return 1.0 - output * output

    # ── Forward pass ──────────────────────────────────────────────────────
    def forward(self, inputs):
        """Returns (output_scalar, list_of_layer_activations)."""
        activations = [list(inputs)]  # layer 0 = input
        current = list(inputs)

        for layer_idx in range(len(self.weights)):
            w = self.weights[layer_idx]
            b = self.biases[layer_idx]
            is_output = (layer_idx == len(self.weights) - 1)
            next_layer = []
            for j in range(len(b)):
                z = b[j]
                for k in range(len(current)):
                    z += current[k] * w[k][j]
                if is_output:
                    a = self._tanh(z)    # output uses tanh → range [-1, 1]
                else:
                    a = self._relu(z)    # hidden uses ReLU
                next_layer.append(a)
            activations.append(next_layer)
            current = next_layer

        return current[0], activations

    # ── Backpropagation ───────────────────────────────────────────────────
    def train(self, inputs, target):
        """Single-sample online SGD with backpropagation."""
        output, activations = self.forward(inputs)
        error = target - output
        self.train_loss = error * error  # MSE for one sample

        # Output layer delta
        deltas = [None] * len(self.weights)
        out_deriv = self._tanh_deriv(output)
        deltas[-1] = [error * out_deriv]

        # Hidden layer deltas (backprop)
        for layer_idx in range(len(self.weights) - 2, -1, -1):
            layer_act = activations[layer_idx + 1]  # activations of this layer
            next_deltas = deltas[layer_idx + 1]
            w = self.weights[layer_idx + 1]
            curr_deltas = []
            for j in range(len(layer_act)):
                # Sum of (weight × delta) from next layer
                downstream = 0.0
                for k in range(len(next_deltas)):
                    downstream += w[j][k] * next_deltas[k]
                d = downstream * self._relu_deriv(layer_act[j])
                curr_deltas.append(d)
            deltas[layer_idx] = curr_deltas

        # Gradient clipping constant
        max_grad = 1.0

        # Update weights and biases with momentum
        for layer_idx in range(len(self.weights)):
            layer_input = activations[layer_idx]
            layer_delta = deltas[layer_idx]
            for j in range(len(layer_delta)):
                for k in range(len(layer_input)):
                    grad = layer_delta[j] * layer_input[k]
                    grad = max(-max_grad, min(max_grad, grad))  # clip
                    self.v_weights[layer_idx][k][j] = self.momentum * self.v_weights[layer_idx][k][j] + self.lr * grad
                    self.weights[layer_idx][k][j] += self.v_weights[layer_idx][k][j]
                grad_b = layer_delta[j]
                grad_b = max(-max_grad, min(max_grad, grad_b))
                self.v_biases[layer_idx][j] = self.momentum * self.v_biases[layer_idx][j] + self.lr * grad_b
                self.biases[layer_idx][j] += self.v_biases[layer_idx][j]

        return output, error

    # ── Predict (convenience) ─────────────────────────────────────────────
    def predict(self, inputs):
        output, activations = self.forward(inputs)
        self.last_activations = activations
        self.last_prediction = output
        return output

    # ── Accuracy tracking ─────────────────────────────────────────────────
    def update_accuracy(self, predicted, actual):
        if (actual > 0 and predicted > 0) or (actual < 0 and predicted < 0):
            self.correct_directions += 1
        self.predictions_made += 1
        self.accuracy = (self.correct_directions / self.predictions_made) * 100 if self.predictions_made > 0 else 0.0

    # ── Serialisation helpers (for API) ───────────────────────────────────
    def get_layer_norms(self):
        """Return average absolute weight per layer for the UI."""
        norms = []
        for w in self.weights:
            total = 0.0
            count = 0
            for row in w:
                for v in row:
                    total += abs(v)
                    count += 1
            norms.append(round(total / max(count, 1), 4))
        return norms

    def get_output_weights(self):
        """Return the final layer's weight vector (for visualising feature importance)."""
        if self.weights:
            last_w = self.weights[-1]
            return [row[0] for row in last_w]  # single output neuron
        return []


# ── FEATURE ENGINEERING ───────────────────────────────────────────────────────

def compute_features(price, prices_list, sma, upper, lower, rsi, bandwidth):
    """Build an 8-dimensional feature vector from raw indicators.

    Features:
      0. f_rsi         — RSI normalised to [-1, 1] centred on 50
      1. f_bb_pos      — Price position within Bollinger Bands [-0.5, 0.5]
      2. f_bw          — Scaled bandwidth (volatility proxy)
      3. f_momentum    — Short-term price momentum (5-tick % change)
      4. f_volatility  — Recent price volatility (stddev of last 10 returns)
      5. f_price_sma   — Price deviation from SMA as a ratio
      6. f_consec_dir  — Consecutive up/down tick direction score
      7. f_mean_rev    — Mean-reversion signal (how far from SMA, scaled)
    """
    features = [0.0] * 8

    bb_range = upper - lower if (upper and lower) else 1.0
    if bb_range == 0:
        bb_range = 1.0

    # 0 — RSI normalised
    features[0] = (rsi - 50) / 50.0 if rsi else 0.0

    # 1 — Bollinger Band position
    features[1] = ((price - lower) / bb_range) - 0.5 if lower else 0.0

    # 2 — Bandwidth (scaled)
    features[2] = (bandwidth * 100) if bandwidth else 0.0

    # 3 — 5-tick momentum
    if len(prices_list) >= 6:
        old_p = prices_list[-6]
        features[3] = ((price - old_p) / old_p) * 100 if old_p != 0 else 0.0
    
    # 4 — Volatility (stddev of last 10 returns)
    if len(prices_list) >= 11:
        returns = []
        for i in range(-10, 0):
            p_prev = prices_list[i - 1]
            p_curr = prices_list[i]
            if p_prev != 0:
                returns.append((p_curr - p_prev) / p_prev * 100)
        if len(returns) >= 2:
            features[4] = statistics.stdev(returns)
        elif len(returns) == 1:
            features[4] = abs(returns[0])

    # 5 — Price / SMA ratio deviation
    if sma and sma != 0:
        features[5] = ((price - sma) / sma) * 100  # % above/below SMA

    # 6 — Consecutive direction score
    if len(prices_list) >= 4:
        streak = 0
        for i in range(-1, -4, -1):
            if prices_list[i] > prices_list[i - 1]:
                streak += 1
            elif prices_list[i] < prices_list[i - 1]:
                streak -= 1
        features[6] = streak / 3.0  # normalise to [-1, 1]

    # 7 — Mean-reversion intensity (z-score from SMA)
    if sma and sma != 0 and len(prices_list) >= 5:
        recent = prices_list[-5:]
        std = statistics.stdev(recent) if len(recent) >= 2 else 1.0
        if std > 0:
            features[7] = (price - sma) / std  # z-score

    return features


# ── STATE ─────────────────────────────────────────────────────────────────────

# Neural network instance (created fresh on each /api/start)
neural_net = None   # type: NeuralNetwork | None

NN_ARCHITECTURE = [8, 16, 8, 4, 1]  # default layer sizes

state = {
    "is_running":            False,
    "symbol":                "BTC",
    "interval":              300,
    "trade_amt":             500.0,
    "api_key":               "",
    "price":                 0.0,
    "sma":                   None,
    "upper":                 None,
    "lower":                 None,
    "rsi":                   None,
    "bandwidth":             None,
    "portfolio":             {"USD": 10000.0, "holdings": {}},
    "window_size":           DEFAULT_BB_WINDOW,
    "avg_buy_price":         None,
    "was_below_lower":       False,
    "was_above_upper":       False,
    "last_trade_interval":   0,
    "interval_count":        0,
    "total_trades":          0,
    "total_buys":            0,
    "total_sells":           0,
    "stop_losses_hit":       0,

    # AI Engine State  (kept for API compat, populated from neural_net)
    "ai_weights":            [0.0, 0.0, 0.0],
    "ai_bias":               0.0,
    "ai_last_features":      None,
    "ai_last_price":         None,
    "ai_prediction":         0.0,
    "ai_accuracy_score":     0.0,
    "ai_predictions_made":   0,
    "ai_correct_directions": 0,

    # Configurable variables
    "position_mode":         "percent",
    "buy_risk_pct":          0.20,
    "stop_loss_pct":         0.07,
    "take_profit_pct":       0.10,
    "ai_learning_rate":      0.005,
    "bb_window":             DEFAULT_BB_WINDOW,
    "bb_stddev":             DEFAULT_BB_STDDEV,
    "rsi_period":            DEFAULT_RSI_PERIOD,
    "rsi_oversold":          DEFAULT_RSI_OVERSOLD,
    "rsi_overbought":        DEFAULT_RSI_OVERBOUGHT,

    # Net Worth calculation helper
    "starting_wallet":       10000.0,

    # History tracking
    "history":               [],
    "last_tick_trade":       None,

    # Neural network metadata (for UI)
    "nn_architecture":       NN_ARCHITECTURE,
    "nn_layer_norms":        [],
    "nn_train_loss":         0.0,
    "nn_feature_names":      ["RSI", "BB Pos", "Bandwidth", "Momentum", "Volatility", "P/SMA", "ConsecDir", "MeanRev"],
}

price_history = deque(maxlen=50)
log_queue     = queue.Queue()
bot_thread    = None
CONFIG_FILE   = "config.json"


# ── HELPERS ───────────────────────────────────────────────────────────────────

def log(message):
    timestamp = time.strftime('%H:%M:%S')
    entry = f"[{timestamp}]  {message}"
    log_queue.put(entry)
    print(entry)

def load_config():
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                config = json.load(f)
                for k, v in config.items():
                    if k in state:
                        state[k] = v
        except Exception:
            log("System: Failed to load config.")

def save_config(key):
    try:
        with open(CONFIG_FILE, "w") as f:
            json.dump({"api_key": key}, f)
    except Exception:
        log("System: Config save failed.")


# ── INDICATORS ────────────────────────────────────────────────────────────────

def compute_bollinger(prices):
    bb_w = state.get("bb_window", DEFAULT_BB_WINDOW)
    if len(prices) < bb_w:
        return None, None, None
    window = list(prices)[-bb_w:]
    sma    = statistics.mean(window)
    std    = statistics.stdev(window)
    bb_dev = state.get("bb_stddev", DEFAULT_BB_STDDEV)
    return sma, sma + (std * bb_dev), sma - (std * bb_dev)

def compute_rsi(prices, period=None):
    if period is None:
        period = state.get("rsi_period", DEFAULT_RSI_PERIOD)
    prices = list(prices)
    if len(prices) < period + 1:
        return None

    recent = prices[-(period + 1):]
    deltas = [recent[i] - recent[i - 1] for i in range(1, len(recent))]

    gains  = [d for d in deltas if d > 0]
    losses = [abs(d) for d in deltas if d < 0]

    avg_gain = sum(gains)  / period if gains  else 0.0
    avg_loss = sum(losses) / period if losses else 1e-9

    rs  = avg_gain / avg_loss
    rsi = 100.0 - (100.0 / (1.0 + rs))
    return round(rsi, 2)

def compute_bandwidth(sma, upper, lower):
    if sma and sma != 0:
        return (upper - lower) / sma
    return None


# ── PRICE FEED ────────────────────────────────────────────────────────────────

def fetch_price(symbol, api_key):
    url    = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest"
    params = urllib.parse.urlencode({"symbol": symbol, "convert": "USD"})
    req    = urllib.request.Request(
        f"{url}?{params}",
        headers={"X-CMC_PRO_API_KEY": api_key}
    )
    context = ssl.create_default_context(cafile=certifi.where())
    
    retries = 3
    backoff = 2
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, context=context) as response:
                data = json.load(response)
                return data["data"][symbol]["quote"]["USD"]["price"]
        except Exception as e:
            if attempt < retries - 1:
                sleep_time = backoff ** attempt
                log(f"Warning: Price fetch failed ({e}). Retrying in {sleep_time}s...")
                time.sleep(sleep_time)
            else:
                log(f"Error: Invalid API token or connection refused after {retries} attempts. ({e})")
                return None


# ── TRADE EXECUTION ───────────────────────────────────────────────────────────

def execute_trade(side, price, reason="signal"):
    symbol    = state["symbol"]
    portfolio = state["portfolio"]

    if side == "BUY":
        if state.get("position_mode", "percent") == "fixed":
            trade_amt = state.get("trade_amt", 500.0)
        else:
            trade_amt = portfolio["USD"] * state.get("buy_risk_pct", 0.20)

        if trade_amt > portfolio["USD"]:
            trade_amt = portfolio["USD"]

        if trade_amt < 1.0:
            log(f"Risk: Skipped BUY — insufficient USD balance (${portfolio['USD']:.2f})")
            return False

        bought = trade_amt / price
        portfolio["USD"] -= trade_amt

        prev_holdings = portfolio["holdings"].get(symbol, 0)
        prev_avg      = state["avg_buy_price"] or price
        portfolio["holdings"][symbol] = prev_holdings + bought

        if prev_holdings > 0:
            state["avg_buy_price"] = ((prev_avg * prev_holdings + price * bought) / (prev_holdings + bought))
        else:
            state["avg_buy_price"] = price

        state["total_trades"] += 1
        state["total_buys"]   += 1
        state["last_tick_trade"] = "BUY"
        log(f"Execution: Filled BUY  {bought:.6f} {symbol}  @  ${price:,.2f}  |  Risked: ${trade_amt:,.2f}  |  Reason: {reason}")
        return True

    elif side == "SELL":
        owned = portfolio["holdings"].get(symbol, 0)
        if owned <= 0:
            log(f"Risk: Skipped SELL — no {symbol} holdings")
            return False

        # Liquidate entire position on stop-loss, otherwise sell SELL_PCT (50%)
        sell_pct = 1.0 if reason == "stop-loss" else SELL_PCT
        sell_qty = owned * sell_pct
        proceeds = sell_qty * price
        portfolio["USD"] += proceeds
        portfolio["holdings"][symbol] = owned - sell_qty

        pnl_str = ""
        if state["avg_buy_price"]:
            pnl = (price - state["avg_buy_price"]) / state["avg_buy_price"] * 100
            pnl_str = f"  |  PnL: {pnl:+.2f}%"

        if portfolio["holdings"][symbol] < 1e-8:
            portfolio["holdings"][symbol] = 0
            state["avg_buy_price"] = None

        state["total_trades"] += 1
        state["total_sells"]  += 1
        state["last_tick_trade"] = "STOP_LOSS" if reason == "stop-loss" else "SELL"
        log(f"Execution: Filled SELL {sell_qty:.6f} {symbol}  @  ${price:,.2f}  |  Proceeds: ${proceeds:,.2f}{pnl_str}  |  Reason: {reason}")
        return True

    return False

# ── EXPORT STATE ──────────────────────────────────────────────────────────────

def save_data_to_json():
    try:
        export_data = {
            "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
            "symbol": state["symbol"],
            "price": state["price"] if state["price"] else None,
            "rsi": state["rsi"],
            "bandwidth": state["bandwidth"],
            "portfolio_usd": state["portfolio"]["USD"],
            "is_running": state["is_running"],
            "ai_data": {
                "weights": state["ai_weights"],
                "bias": state["ai_bias"],
                "accuracy": state["ai_accuracy_score"]
            }
        }
        with open(DATA_EXPORT_FILE, 'w') as f:
            json.dump(export_data, f, indent=2)
    except Exception as e:
        log(f"Export Error: {e}")

def export_on_interval():
    if EXPORT_INTERVAL > 0:
        last_export = getattr(state, "last_export_time", None)
        if last_export is None or (time.time() - last_export) >= EXPORT_INTERVAL:
            save_data_to_json()
            state["last_export_time"] = time.time()


# ── BOT LOOP WITH NEURAL NETWORK ──────────────────────────────────────────────

def _save_history_point(price, sma, upper, lower, rsi):
    """Helper to append a history point and trim to 50."""
    history_point = {
        "price": price,
        "sma": sma,
        "upper": upper,
        "lower": lower,
        "rsi": rsi,
        "timestamp": time.strftime('%H:%M:%S'),
        "trade": state.get("last_tick_trade", None)
    }
    state["history"].append(history_point)
    state["history"] = state["history"][-50:]
    state["last_tick_trade"] = None


def bot_loop():
    global price_history, neural_net
    price_history.clear()

    # Reset signal state
    state["was_below_lower"]      = False
    state["was_above_upper"]      = False
    state["last_trade_interval"]  = 0
    state["interval_count"]       = 0
    state["avg_buy_price"]        = None

    if EXPORT_ON_START:
        save_data_to_json()

    arch = state.get("nn_architecture", NN_ARCHITECTURE)
    lr   = state.get("ai_learning_rate", 0.005)
    log(f"System: Data stream initialized for {state['symbol']}")
    log(f"System: Neural Network online — arch {arch}, lr={lr}")

    while state["is_running"]:
        price = fetch_price(state["symbol"], state["api_key"])

        if price is None:
            state["is_running"] = False
            break

        state["price"] = price
        price_history.append(price)
        state["interval_count"] += 1

        prices    = list(price_history)
        sma, upper, lower = compute_bollinger(prices)
        rsi       = compute_rsi(prices)
        bandwidth = compute_bandwidth(sma, upper, lower) if sma else None

        state["sma"], state["upper"], state["lower"] = sma, upper, lower
        state["rsi"], state["bandwidth"] = rsi, bandwidth

        if sma is None or rsi is None:
            needed = max(state["bb_window"], state["rsi_period"] + 1) - len(prices)
            log(f"Calibrating: ${price:,.2f}  —  {needed} more sample(s) needed")
            _save_history_point(price, None, None, None, None)
            _interruptible_sleep()
            continue

        export_on_interval()

        # ── Build feature vector ──────────────────────────────────────────────
        features = compute_features(price, prices, sma, upper, lower, rsi, bandwidth)

        # ── 1. NEURAL NETWORK TRAINING (backprop on previous prediction) ─────
        if neural_net and neural_net.last_price is not None:
            actual_pct = ((price - neural_net.last_price) / neural_net.last_price) * 100
            predicted  = neural_net.last_prediction

            # Update accuracy
            neural_net.update_accuracy(predicted, actual_pct)

            # Backpropagation — target is the actual movement, scaled and clamped
            target_clamped = max(-1.0, min(1.0, actual_pct * 10.0))  # scale & clamp to tanh range
            neural_net.train(state["ai_last_features"], target_clamped)

            # Sync tracking to state for API
            state["ai_predictions_made"]   = neural_net.predictions_made
            state["ai_correct_directions"] = neural_net.correct_directions
            state["ai_accuracy_score"]     = neural_net.accuracy
            state["nn_train_loss"]         = neural_net.train_loss
            state["nn_layer_norms"]        = neural_net.get_layer_norms()

        # ── 2. NEURAL NETWORK PREDICTION ──────────────────────────────────────
        ai_pred = 0.0
        if neural_net and (upper - lower) != 0:
            ai_pred = neural_net.predict(features)
            neural_net.last_price = price
            state["ai_last_features"] = features
            state["ai_prediction"]    = ai_pred
            state["ai_last_price"]    = price

            # Populate legacy weight fields from the output layer for UI compat
            out_w = neural_net.get_output_weights()
            state["ai_weights"] = out_w[:3] + [0.0] * max(0, 3 - len(out_w))
            state["ai_bias"]    = neural_net.biases[-1][0] if neural_net.biases else 0.0
        else:
            state["ai_prediction"] = 0.0

        ai_pred_str = f"{ai_pred:+.4f}"
        log(f"Signal: ${price:,.2f} | RSI={rsi:.1f} | NN output: {ai_pred_str} (Acc: {state['ai_accuracy_score']:.1f}%)")

        # ── Cooldown & Risk ───────────────────────────────────────────────────
        intervals_since_trade = state["interval_count"] - state["last_trade_interval"]
        on_cooldown           = intervals_since_trade < TRADE_COOLDOWN
        avg_entry = state["avg_buy_price"]
        holdings  = state["portfolio"]["holdings"].get(state["symbol"], 0)

        # Stop-loss
        stop_loss_pct = state.get("stop_loss_pct", 0.07)
        if avg_entry and holdings > 0 and price < avg_entry * (1 - stop_loss_pct):
            if execute_trade("SELL", price, reason="stop-loss"):
                state["stop_losses_hit"] += 1
                state["last_trade_interval"] = state["interval_count"]
                state["was_above_upper"] = state["was_below_lower"] = False
            _save_history_point(price, sma, upper, lower, rsi)
            _interruptible_sleep()
            continue

        # Take-profit
        take_profit_pct = state.get("take_profit_pct", 0.10)
        if avg_entry and holdings > 0 and price > avg_entry * (1 + take_profit_pct):
            if execute_trade("SELL", price, reason="take-profit"):
                state["last_trade_interval"] = state["interval_count"]
                state["was_above_upper"] = state["was_below_lower"] = False
            _save_history_point(price, sma, upper, lower, rsi)
            _interruptible_sleep()
            continue

        if bandwidth is not None and bandwidth < MIN_BANDWIDTH:
            _save_history_point(price, sma, upper, lower, rsi)
            _interruptible_sleep()
            continue

        # Band tracking
        if price < lower: state["was_below_lower"] = True
        elif price > upper: state["was_above_upper"] = True

        # ── BUY CONDITIONS ───────────────────────────────────────────────────
        elif state["was_below_lower"] and price >= lower:
            state["was_below_lower"] = False
            rsi_oversold = state.get("rsi_oversold", 35)
            if on_cooldown:
                log("Risk: BUY skipped — cooldown")
            elif rsi > rsi_oversold:
                log(f"Filter: BUY skipped — RSI {rsi:.1f} not oversold")
            elif ai_pred < 0:
                log(f"NN Filter: BUY vetoed — network predicts drop ({ai_pred_str})")
            else:
                if execute_trade("BUY", price, reason="BB re-entry + RSI + NN Appv"):
                    state["last_trade_interval"] = state["interval_count"]

        # ── SELL CONDITIONS ──────────────────────────────────────────────────
        elif state["was_above_upper"] and price <= upper:
            state["was_above_upper"] = False
            rsi_overbought = state.get("rsi_overbought", 65)
            if on_cooldown:
                log("Risk: SELL skipped — cooldown")
            elif rsi < rsi_overbought:
                log(f"Filter: SELL skipped — RSI {rsi:.1f} not overbought")
            elif ai_pred > 0:
                log(f"NN Filter: SELL vetoed — network predicts pump ({ai_pred_str})")
            else:
                if execute_trade("SELL", price, reason="BB re-entry + RSI + NN Appv"):
                    state["last_trade_interval"] = state["interval_count"]

        _save_history_point(price, sma, upper, lower, rsi)
        _interruptible_sleep()

    if EXPORT_ON_STOP:
        save_data_to_json()


def _interruptible_sleep():
    for _ in range(state["interval"]):
        if not state["is_running"]:
            break
        time.sleep(1)


# ── API ROUTES ────────────────────────────────────────────────────────────────

def _bb_position_str(price, upper, lower):
    if price is None or upper is None or lower is None or upper == lower:
        return "within bands"
    if price >= upper:
        return "near upper band"
    if price <= lower:
        return "near lower band"
    mid = (upper + lower) / 2
    if price > mid:
        return "above midline"
    return "below midline"

def _get_feature(features, idx):
    if features and isinstance(features, list) and len(features) > idx:
        return round(features[idx], 6)
    return 0.0

@app.route("/api/status", methods=["GET"])
def get_status():
    symbol = state["symbol"]
    price = state["price"] or 0.0
    holdings = state["portfolio"]["holdings"].get(symbol, 0)
    usd = state["portfolio"]["USD"]
    
    net_worth = usd + (holdings * price)
    starting = state.get("starting_wallet", 10000.0)
    pnl_usd = net_worth - starting
    pnl_pct = (pnl_usd / starting * 100) if starting > 0 else 0.0
    
    # Gather live neural net layer activations for the UI
    nn_activations = []
    if neural_net and neural_net.last_activations:
        for layer in neural_net.last_activations:
            nn_activations.append([round(v, 4) for v in layer])

    return jsonify({
        "is_running":      state["is_running"],
        "symbol":          symbol,
        "price":           state["price"],
        "sma":             state["sma"],
        "upper":           state["upper"],
        "lower":           state["lower"],
        "rsi":             state["rsi"],
        "bandwidth":       state["bandwidth"],
        "usd":             usd,
        "holdings":        holdings,
        "holdings_all":    state["portfolio"]["holdings"],
        "net_worth":       net_worth,
        "pnl_usd":         pnl_usd,
        "pnl_pct":         pnl_pct,
        "api_key":         state["api_key"],
        "interval":        state["interval"],
        "trade_amt":       state["trade_amt"],
        "avg_buy_price":   state["avg_buy_price"],
        "total_trades":    state["total_trades"],
        "total_buys":      state["total_buys"],
        "total_sells":     state["total_sells"],
        "stop_losses_hit": state["stop_losses_hit"],
        "ai_prediction":   state["ai_prediction"],
        "ai_accuracy":     state["ai_accuracy_score"],
        "ai_weights":      state["ai_weights"],
        "ai_bias":         state["ai_bias"],
        "history":         list(state["history"]),
        # Derived fields for frontend
        "bb_position":      _bb_position_str(state.get("price"), state.get("upper"), state.get("lower")),
        "momentum_5tick":   _get_feature(state.get("ai_last_features"), 3),
        # Neural network specific
        "nn_architecture":   state.get("nn_architecture", NN_ARCHITECTURE),
        "nn_layer_norms":    state.get("nn_layer_norms", []),
        "nn_train_loss":     state.get("nn_train_loss", 0.0),
        "nn_activations":    nn_activations,
        "nn_feature_names":  state.get("nn_feature_names", []),
    })

@app.route("/api/start", methods=["POST"])
def start_bot():
    global bot_thread, price_history

    if state["is_running"]:
        return jsonify({"error": "Already running"}), 400

    body    = request.get_json()
    api_key = body.get("api_key", "").strip()
    if not api_key:
        return jsonify({"error": "API key required"}), 400

    save_config(api_key)
    state["api_key"]               = api_key
    state["symbol"]                = body.get("symbol", "BTC").upper()
    state["interval"]              = int(body.get("interval", 300))
    state["trade_amt"]             = float(body.get("trade_amt", 500))
    state["portfolio"]["USD"]      = float(body.get("wallet", 10000))
    state["portfolio"]["holdings"] = {}
    
    # Configurable variables
    state["position_mode"]         = body.get("position_mode", "percent")
    state["buy_risk_pct"]          = float(body.get("buy_risk_pct", 0.20))
    state["stop_loss_pct"]         = float(body.get("stop_loss_pct", 0.07))
    state["take_profit_pct"]       = float(body.get("take_profit_pct", 0.10))
    state["ai_learning_rate"]      = float(body.get("ai_learning_rate", 0.01))
    state["bb_window"]             = int(body.get("bb_window", DEFAULT_BB_WINDOW))
    state["bb_stddev"]             = float(body.get("bb_stddev", DEFAULT_BB_STDDEV))
    state["rsi_period"]            = int(body.get("rsi_period", DEFAULT_RSI_PERIOD))
    state["rsi_oversold"]          = int(body.get("rsi_oversold", DEFAULT_RSI_OVERSOLD))
    state["rsi_overbought"]        = int(body.get("rsi_overbought", DEFAULT_RSI_OVERBOUGHT))
    
    # Initialize dynamic history
    state["starting_wallet"]       = float(body.get("wallet", 10000.0))
    state["history"]               = []
    state["last_tick_trade"]       = None

    # Create fresh neural network
    lr = state["ai_learning_rate"]
    neural_net = NeuralNetwork(NN_ARCHITECTURE, learning_rate=lr)
    state["nn_architecture"]       = NN_ARCHITECTURE
    state["nn_layer_norms"]        = []
    state["nn_train_loss"]         = 0.0
    state["ai_predictions_made"]   = 0
    state["ai_correct_directions"] = 0
    state["ai_accuracy_score"]     = 0.0
    state["ai_last_features"]      = None
    state["ai_last_price"]         = None

    price_history = deque(maxlen=state["bb_window"] + state["rsi_period"] + 5)
    state["is_running"] = True
    bot_thread = threading.Thread(target=bot_loop, daemon=True)
    bot_thread.start()

    return jsonify({"status": "started"})

@app.route("/api/stop", methods=["POST"])
def stop_bot():
    state["is_running"] = False
    return jsonify({"status": "stopped"})

@app.route("/api/logs", methods=["GET"])
def stream_logs():
    def generate():
        yield "retry: 1000\n\n"
        while True:
            try:
                msg = log_queue.get(timeout=15)
                yield f"data: {json.dumps(msg)}\n\n"
            except queue.Empty:
                yield ": heartbeat\n\n"
    return Response(generate(), mimetype="text/event-stream")

@app.route("/api/config", methods=["GET", "POST"])
def manage_config():
    if request.method == "POST":
        body = request.get_json()
        try:
            config = {}
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE, "r") as f:
                    config = json.load(f)
            
            for k, v in body.items():
                config[k] = v
                if k in state:
                    state[k] = v
            
            with open(CONFIG_FILE, "w") as f:
                json.dump(config, f)
            return jsonify({"status": "saved"})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    else:
        config = {}
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, "r") as f:
                    config = json.load(f)
            except Exception:
                pass
        
        for k in ["api_key", "symbol", "interval", "trade_amt", "position_mode", "buy_risk_pct", "stop_loss_pct", "take_profit_pct", "ai_learning_rate", "bb_window", "bb_stddev", "rsi_period", "rsi_oversold", "rsi_overbought"]:
            if k not in config:
                config[k] = state.get(k, "")
        return jsonify(config)

@app.route("/api/cmc/global", methods=["GET"])
def get_cmc_global():
    api_key = state.get("api_key", "").strip()
    if not api_key:
        return jsonify({"error": "API key required"}), 400

    url = "https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest"
    req = urllib.request.Request(url, headers={"X-CMC_PRO_API_KEY": api_key})
    context = ssl.create_default_context(cafile=certifi.where())
    try:
        with urllib.request.urlopen(req, context=context) as response:
            data = json.load(response)
            return jsonify(data)
    except Exception as e:
        log(f"Error fetching global metrics from CMC: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/cmc/listings", methods=["GET"])
def get_cmc_listings():
    api_key = state.get("api_key", "").strip()
    if not api_key:
        return jsonify({"error": "API key required"}), 400

    url = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest"
    req = urllib.request.Request(url, headers={"X-CMC_PRO_API_KEY": api_key})
    context = ssl.create_default_context(cafile=certifi.where())
    try:
        with urllib.request.urlopen(req, context=context) as response:
            data = json.load(response)
            return jsonify(data)
    except Exception as e:
        log(f"Error fetching listings from CMC: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/manual/trade", methods=["POST"])
def manual_trade():
    body = request.get_json() or {}
    side = body.get("side", "").upper()
    symbol = body.get("symbol", "").upper()
    price = float(body.get("price", 0.0))
    amount = float(body.get("amount", 0.0))
    
    if side not in ["BUY", "SELL"] or not symbol or price <= 0 or amount <= 0:
        return jsonify({"error": "Invalid trade parameters"}), 400
        
    portfolio = state["portfolio"]
    if side == "BUY":
        if amount > portfolio["USD"]:
            return jsonify({"error": f"Insufficient USD balance (${portfolio['USD']:.2f})"}), 400
        qty = amount / price
        portfolio["USD"] -= amount
        
        prev_holdings = portfolio["holdings"].get(symbol, 0.0)
        portfolio["holdings"][symbol] = prev_holdings + qty
        
        # update average buy price for main symbol
        if symbol == state["symbol"]:
            prev_avg = state["avg_buy_price"] or price
            if prev_holdings > 0:
                state["avg_buy_price"] = ((prev_avg * prev_holdings) + (price * qty)) / (prev_holdings + qty)
            else:
                state["avg_buy_price"] = price
                
        state["total_trades"] += 1
        state["total_buys"] += 1
        
        msg = f"Manual BUY: {qty:.6f} {symbol} @ ${price:,.2f} for ${amount:,.2f}"
        log(f"Execution: {msg}")
        return jsonify({"status": "success", "message": msg})
        
    elif side == "SELL":
        owned = portfolio["holdings"].get(symbol, 0.0)
        if amount > owned:
            return jsonify({"error": f"Insufficient holdings for {symbol} ({owned:.6f})"}), 400
            
        proceeds = amount * price
        portfolio["USD"] += proceeds
        portfolio["holdings"][symbol] = owned - amount
        
        pnl_str = ""
        if symbol == state["symbol"] and state["avg_buy_price"]:
            pnl = ((price - state["avg_buy_price"]) / state["avg_buy_price"]) * 100.0
            pnl_str = f" | PnL: {pnl:+.2f}%"
            
        if portfolio["holdings"][symbol] < 1e-8:
            portfolio["holdings"][symbol] = 0.0
            if symbol == state["symbol"]:
                state["avg_buy_price"] = None
                
        state["total_trades"] += 1
        state["total_sells"] += 1
        
        msg = f"Manual SELL: {amount:.6f} {symbol} @ ${price:,.2f} for ${proceeds:,.2f}{pnl_str}"
        log(f"Execution: {msg}")
        return jsonify({"status": "success", "message": msg})

@app.route("/api/manual/funds", methods=["POST"])
def manage_funds():
    body = request.get_json() or {}
    action = body.get("action", "")
    amount = float(body.get("amount", 0.0))
    
    if action not in ["add", "remove"] or amount <= 0:
        return jsonify({"error": "Invalid funds parameters"}), 400
        
    portfolio = state["portfolio"]
    if action == "add":
        portfolio["USD"] += amount
        state["starting_wallet"] = state.get("starting_wallet", 10000.0) + amount
        msg = f"Manually added ${amount:,.2f} USD to portfolio balance."
        log(f"System: {msg}")
        return jsonify({"status": "success", "message": msg})
    elif action == "remove":
        to_remove = min(amount, portfolio["USD"])
        portfolio["USD"] -= to_remove
        state["starting_wallet"] = max(0.0, state.get("starting_wallet", 10000.0) - to_remove)
        msg = f"Manually removed ${to_remove:,.2f} USD from portfolio balance."
        log(f"System: {msg}")
        return jsonify({"status": "success", "message": msg})

@app.route("/api/manual/reset", methods=["POST"])
def reset_portfolio_endpoint():
    starting = state.get("starting_wallet", 10000.0)
    state["portfolio"] = {"USD": starting, "holdings": {}}
    state["avg_buy_price"] = None
    state["total_trades"] = 0
    state["total_buys"] = 0
    state["total_sells"] = 0
    state["stop_losses_hit"] = 0
    msg = "Portfolio and trade statistics manually reset."
    log(f"System: {msg}")
    return jsonify({"status": "success", "message": msg})

@app.route("/api/log", methods=["POST"])
def post_log():
    body = request.get_json() or {}
    message = body.get("message", "")
    if message:
        log(message)
    return jsonify({"status": "ok"})

if __name__ == "__main__":
    load_config()
    log(f"System: ultraexchange engine online  |  port 5678  |  math engine v4 (Neural Network {NN_ARCHITECTURE})")
    app.run(host="127.0.0.1", port=5678, debug=False, threaded=True)