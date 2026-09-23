# ✅ Strategy Buttons Updated - Individual Strategy Selection

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md).

## 🎯 **What Changed**

Replaced the cycling "EditTrades" button with **individual strategy buttons** for direct selection.

---

## 🔄 **Before → After**

### Before:
```
┌─────────────────────────────────┐
│ [EditTrades] [4h] [Swing] [Scalp] │
└─────────────────────────────────┘
```
- Click "EditTrades" to cycle through strategies
- Indicator boxes (non-clickable) show status

### After:
```
        EDITTRADES
┌─────────────────────────────────┐
│ [4H] [Swing] [Scalp] [M-S]      │
└─────────────────────────────────┘
```
- Static "EDITTRADES" label above
- 4 individual clickable buttons
- Direct strategy selection
- M-S = Micro-Scalp

---

## 🎨 **Button States & Colors**

### Active Button (Selected):
```css
background: rgba(255, 255, 255, 0.1)
color: var(--color-yellow-75) /* Yellow-white */
```

### Has Valid LONG Trade:
```css
background: transparent
color: #10b981 /* Green */
```

### Has Valid SHORT Trade:
```css
background: transparent
color: #ef4444 /* Red */
```

### No Trade (Inactive):
```css
background: transparent
color: #6b7280 /* Grey */
```

---

## 📊 **Button Layout**

### Desktop/Mobile:
```
EDITTRADES (label)
─────────────────
[4H] [Swing] [Scalp] [M-S]
```

### Button Sizes:
- **4H**: 40px min-width
- **Swing**: 45px min-width
- **Scalp**: 42px min-width
- **M-S**: 35px min-width (smaller, abbreviated)

---

## 🔘 **Four Strategy Buttons**

### 1. 4H Button
- **Strategy**: 4-Hour "Set & Forget"
- **onclick**: `setStrategy(symbol, 0)`
- **Color**: Green/Red when valid trade, Grey when no trade

### 2. Swing Button
- **Strategy**: 3D → 1D → 4H Swing
- **onclick**: `setStrategy(symbol, 1)`
- **Color**: Green/Red when valid trade, Grey when no trade

### 3. Scalp Button
- **Strategy**: 15m/5m LTF Scalp
- **onclick**: `setStrategy(symbol, 2)`
- **Color**: Green/Red when valid trade, Grey when no trade

### 4. M-S Button (NEW!)
- **Strategy**: Micro-Scalp (Mean Reversion)
- **onclick**: `setStrategy(symbol, 3)`
- **Color**: Green/Red when valid trade, Grey when no trade
- **Label**: "M-S" (abbreviated to save space)

---

## 🎯 **New Functions**

### 1. `setStrategy(symbol, strategyIndex)`
Replaces `cycleStrategy()`:
```javascript
// Direct strategy selection
setStrategy('BTCUSDT', 0); // Select 4H
setStrategy('BTCUSDT', 1); // Select Swing
setStrategy('BTCUSDT', 2); // Select Scalp
setStrategy('BTCUSDT', 3); // Select Micro-Scalp
```

**What it does:**
- Sets the active strategy index
- Updates button appearance
- Evaluates the selected strategy signal
- Updates signal display
- Updates entry price
- Triggers AI review

### 2. `updateStrategyButtons(symbol)`
Replaces `updateStrategyIndicators()`:
```javascript
// Updates all 4 button colors based on trade signals
updateStrategyButtons('BTCUSDT');
```

**What it does:**
- Evaluates all 4 strategies
- Colors buttons:
  - **Active**: Yellow-white
  - **Long trade**: Green
  - **Short trade**: Red
  - **No trade**: Grey

---

## 🚀 **Micro-Scalp Integration**

### Strategy Array Updated:
```javascript
// Before
const strategyOptions = ['4h', 'Swing', 'Scalp'];

// After
const strategyOptions = ['4h', 'Swing', 'Scalp', 'MicroScalp'];
```

### Micro-Scalp Logic:
```javascript
if (templateKey === 'MicroScalp') {
  // Show microScalp signal from API if available
  if (data.microScalp && data.microScalp.valid) {
    templateSignal = {
      valid: true,
      direction: data.microScalp.direction,
      confidence: data.microScalp.confidence,
      entryZone: data.microScalp.entry,
      setupType: 'MicroScalp'
    };
  } else {
    templateSignal = {
      valid: false,
      direction: 'NO_TRADE',
      reason: '4H must be FLAT for micro-scalp activation'
    };
  }
}
```

---

## 🎨 **Color Coding Examples**

### Scenario 1: BTC has valid 4H LONG
```
EDITTRADES
──────────────────
[4H]    [Swing] [Scalp] [M-S]
 🟢      ⚪      ⚪      ⚪
Green   Grey    Grey    Grey
```

### Scenario 2: BTC has valid Swing SHORT
```
EDITTRADES
──────────────────
[4H]    [Swing] [Scalp] [M-S]
 ⚪      🔴      ⚪      ⚪
Grey    Red     Grey    Grey
```

### Scenario 3: User selects Scalp (active)
```
EDITTRADES
──────────────────
[4H]    [Swing] [Scalp] [M-S]
 ⚪      ⚪      🟡      ⚪
Grey    Grey    Yellow  Grey
        (active)
```

### Scenario 4: Multiple valid trades
```
EDITTRADES
──────────────────
[4H]    [Swing] [Scalp] [M-S]
 🟢      🟢      ⚪      🔴
Green   Green   Grey    Red
(Long)  (Long)          (Short)
```

---

## 📱 **Responsive Design**

### Mobile:
- Label stacks above buttons
- Buttons wrap if needed
- Font sizes adjusted for small screens
- M-S button uses smaller font (0.6rem)

### Desktop:
- All buttons in single row
- Proper spacing and alignment
- Center-aligned in table cell

---

## 🧪 **Testing Checklist**

### Test: `http://localhost:3000`

1. ✅ **Load homepage**
2. ✅ **See "EDITTRADES" label** above strategy buttons
3. ✅ **See 4 buttons**: 4H, Swing, Scalp, M-S
4. ✅ **Click each button** → strategy should change
5. ✅ **Verify color coding**:
   - Active button: Yellow-white
   - Valid long trade: Green
   - Valid short trade: Red
   - No trade: Grey
6. ✅ **Check signal updates** when clicking buttons
7. ✅ **Check entry price updates** when clicking buttons
8. ✅ **Expand details** → verify trade call updates
9. ✅ **Test M-S button** → shows micro-scalp signals
10. ✅ **Test mobile view** → buttons stack properly

---

## ✅ **Key Features**

1. ✅ **Direct Selection** - Click any strategy directly
2. ✅ **Visual Feedback** - Color shows trade availability
3. ✅ **Long/Short Indication** - Green for long, red for short
4. ✅ **4 Strategies** - 4H, Swing, Scalp, Micro-Scalp
5. ✅ **Real-time Updates** - Colors update based on live signals
6. ✅ **Mobile Optimized** - Works on small screens
7. ✅ **AI Integration** - Triggers AI review on strategy change

---

## 🎯 **Summary**

Replaced cycling button with:
- ✅ **"EDITTRADES" label** (static)
- ✅ **4 individual buttons** (clickable)
- ✅ **Green for long** trades
- ✅ **Red for short** trades
- ✅ **Yellow for active** strategy
- ✅ **Grey for no trade**
- ✅ **Micro-Scalp included** (4th button)

**Test it at http://localhost:3000!** 🚀

---

*Last Updated: 2025-11-28*  
*Status: Individual strategy buttons - local testing*

