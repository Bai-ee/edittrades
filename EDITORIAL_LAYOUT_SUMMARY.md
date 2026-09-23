# Editorial Layout & Typography Normalization

> **Legacy (Nov–Dec 2025).** Not updated for the September 2026 scalp-context engine (payload schema 1.10.0). Current docs: [docs/DOCUMENTATION_INDEX.md](./docs/DOCUMENTATION_INDEX.md).

## 🎨 **What Changed**

### 1. **Editorial Grid Layout**
The trade call description section (above timeframes) now uses a modern, magazine-style editorial grid layout that:
- ✅ Fills available space efficiently
- ✅ Uses percentage-based widths (`minmax(250px, 1fr)`)
- ✅ Collapses gracefully on mobile (single column)
- ✅ Maintains readability across all screen sizes

---

### 2. **Typography Normalization**
All text across the entire details section now uses:
- **Font**: `Mathias` (via `var(--font-mathias)`)
- **Color**: Yellow-white (`var(--color-yellow-75)`)
- **Consistency**: Same font across trade calls, timeframe cards, and AI responses

---

## 📐 **Layout Structure**

### Trade Call Output (NEW)

```
┌─────────────────────────────────────────────────────────┐
│  BITCOIN — LONG (SWING)                                 │
│  Confidence: 85%  |  Direction: ⬆️  |  Setup: Swing    │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  Left Column (250px-1fr)    Right Column (250px-1fr)   │
│  ├─ Entry                   ├─ Targets                 │
│  ├─ Stop Loss               ├─ Invalidation            │
│  └─ Risk/Reward                                         │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Full Width: Confluence Analysis                        │
│  (Grid: auto-fit, minmax(200px, 1fr))                  │
├─────────────────────────────────────────────────────────┤
│  Full Width: Conditions Required                        │
│  (Grid: auto-fit, minmax(250px, 1fr))                  │
└─────────────────────────────────────────────────────────┘
```

### Responsive Behavior

**Desktop (> 768px):**
- 2-column grid for Entry/Risk & Targets/Analysis
- Multi-column grids for confluence and conditions
- Optimal space utilization

**Tablet (500px - 768px):**
- Columns may collapse to 1 column based on content
- Still attempts 2-column layout when space allows

**Mobile (< 500px):**
- Single column for all sections
- Full-width cards
- Vertical stacking
- No horizontal scroll

---

## 🎯 **Key Improvements**

### Before:
```css
/* Old: Linear vertical layout */
<div>ENTRY: $90,500</div>
<div>STOP LOSS: $89,800</div>
<div>TARGETS: ...</div>
<div>RISK/REWARD: ...</div>
```

### After:
```css
/* New: Editorial grid layout */
<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));">
  <div>
    <div>ENTRY</div>
    <div>STOP LOSS</div>
    <div>RISK/REWARD</div>
  </div>
  <div>
    <div>TARGETS</div>
    <div>INVALIDATION</div>
  </div>
</div>
```

---

## 🎨 **Typography Changes**

### Trade Call Headers
```css
/* NEW */
font-size: clamp(1.25rem, 4vw, 1.75rem);  /* Responsive sizing */
font-family: var(--font-mathias);
color: var(--color-yellow-75);
letter-spacing: 0.05em;
text-transform: uppercase;
```

### Section Labels
```css
/* NEW */
font-size: 0.75rem;
font-weight: bold;
letter-spacing: 0.1em;
text-transform: uppercase;
color: var(--color-yellow-75);
```

### Content Text
```css
/* NEW */
font-size: 0.875rem - 1.125rem;
font-family: var(--font-mathias);
color: var(--color-yellow-75);
line-height: 1.5 - 1.8;
```

### Secondary Text
```css
/* NEW */
color: rgba(255, 255, 255, 0.5-0.7);  /* Dimmed yellow-white */
font-family: var(--font-mathias);
```

---

## 📱 **Mobile Optimizations**

### Responsive Font Sizing
```css
/* Headers adapt to screen size */
font-size: clamp(1.25rem, 4vw, 1.75rem);

/* Minimum 1.25rem on tiny screens */
/* Maximum 1.75rem on large screens */
/* Scales smoothly based on viewport width */
```

### Grid Behavior
```css
/* Automatically collapses to single column when needed */
grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));

/* minmax(250px, 1fr) means:
   - Minimum column width: 250px
   - Maximum: fills available space
   - auto-fit: collapses to fewer columns when space is tight
*/
```

---

## 🎨 **Color Normalization**

### Before (Inconsistent):
- Some text: `var(--text-primary)`
- Some text: `var(--text-secondary)`
- Some text: `#fff`
- Some text: `rgba(255, 255, 255, 0.8)`

### After (Consistent):
- Primary text: `var(--color-yellow-75)`
- Secondary text: `rgba(255, 255, 255, 0.5-0.7)` or `color: var(--color-yellow-75); opacity: 0.6;`
- All use the same yellow-white base color

---

## 📊 **Sections Updated**

### 1. **Valid Trade Call** (LONG/SHORT)
- ✅ Editorial grid layout
- ✅ Mathias font throughout
- ✅ Yellow-white color scheme
- ✅ Responsive headers
- ✅ 2-column → 1-column on mobile

### 2. **NO TRADE Call**
- ✅ Editorial grid layout
- ✅ Mathias font throughout
- ✅ Yellow-white with gray accents
- ✅ Reason section highlighted
- ✅ Conditions grid layout

### 3. **Micro-Scalp Call**
- ✅ Editorial grid layout
- ✅ Mathias font throughout
- ✅ Yellow banner for LTF warning
- ✅ Same responsive behavior
- ✅ Tight stops emphasized

### 4. **Timeframe Cards**
- ✅ Added `font-family: var(--font-mathias)`
- ✅ All labels: `color: var(--color-yellow-75); opacity: 0.6;`
- ✅ All values: `color: var(--color-yellow-75);`
- ✅ Consistent typography across all cards

---

## 🔧 **Technical Details**

### CSS Grid Properties Used

```css
/* Editorial layout */
display: grid;
grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
gap: 1.5rem;

/* Responsive headings */
font-size: clamp(1.25rem, 4vw, 1.75rem);

/* Nested grids for confluence */
display: grid;
grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
gap: 0.5rem;
```

### Benefits of `auto-fit`:
- Automatically calculates optimal column count
- Collapses to fewer columns when space is limited
- No media queries needed for basic responsiveness
- Content-aware layout

---

## 📏 **Spacing System**

### Gap Hierarchy
```
Primary sections:   gap: 1.5rem  (24px)
Secondary sections: gap: 1rem    (16px)
Inline elements:    gap: 0.5rem  (8px)
```

### Padding System
```
Cards:              padding: 1.5rem
Sections:           padding-top: 1.5rem
Sub-sections:       padding: 0.75rem
```

---

## 🎯 **Visual Hierarchy**

### Level 1: Main Header
```
Font: clamp(1.25rem, 4vw, 1.75rem)
Color: var(--color-yellow-75) OR direction color
Weight: bold
Letter-spacing: 0.05em
```

### Level 2: Section Labels
```
Font: 0.75rem
Color: var(--color-yellow-75)
Weight: bold
Letter-spacing: 0.1em
Transform: uppercase
```

### Level 3: Content Values
```
Font: 0.875rem - 1.125rem
Color: var(--color-yellow-75)
Weight: bold (for emphasis)
Line-height: 1.5-1.8
```

### Level 4: Secondary Info
```
Font: 0.75rem
Color: rgba(255, 255, 255, 0.5)
Weight: normal
```

---

## 🌐 **Browser Compatibility**

### CSS Grid
- ✅ All modern browsers (2023+)
- ✅ Safari, Chrome, Firefox, Edge
- ✅ Mobile browsers (iOS Safari, Chrome Mobile)

### `clamp()` Function
- ✅ All modern browsers (2020+)
- ✅ Graceful degradation: falls back to `1.5rem` if unsupported

### CSS Variables
- ✅ All modern browsers
- ✅ Applied consistently via `:root`

---

## 📱 **Testing Checklist**

- [x] Desktop (1920px+): 2-column layout
- [x] Laptop (1366px): 2-column layout
- [x] Tablet (768px): 1-2 columns (adaptive)
- [x] Mobile (375px): 1 column, full width
- [x] iPhone SE (320px): Single column, no overflow
- [x] All text uses Mathias font
- [x] All text uses yellow-white color
- [x] No horizontal scroll on any screen size
- [x] Readable on all devices

---

## 🚀 **Deployed To**

**Production URL:**
```
https://snapshottradingview-ggr7v5xbw-baiees-projects.vercel.app
```

**Changes Live:**
- ✅ Editorial grid layout
- ✅ Normalized typography
- ✅ Consistent colors
- ✅ Responsive design
- ✅ All templates updated

---

## 📝 **Summary**

### What You'll See:

1. **Trade call sections look more magazine-like**
   - Content organized in side-by-side columns
   - Efficient use of horizontal space
   - Clean, editorial aesthetic

2. **Everything is the same font now**
   - Mathias everywhere
   - Professional consistency
   - No more mismatched fonts

3. **One unified color scheme**
   - All text: yellow-white
   - No more color inconsistencies
   - Clean, cohesive look

4. **Perfect mobile experience**
   - Collapses to single column
   - No horizontal scroll
   - Optimal readability

---

## 🔄 **Before & After**

### Before:
```
ENTRY:
$90,500 – $91,000

STOP LOSS:
$89,800

TARGETS:
TP1 (3R): $95,000
TP2 (4R): $98,500
TP3 (5R): $102,000
```

### After:
```
┌──────────────────────┬──────────────────────┐
│ ENTRY                │ TARGETS              │
│ $90,500 – $91,000    │ TP1 (3R): $95,000   │
│                      │ TP2 (4R): $98,500   │
│ STOP LOSS            │ TP3 (5R): $102,000  │
│ $89,800              │                      │
│                      │ INVALIDATION         │
│ RISK / REWARD        │ Close below $85,250  │
│ 3R to 5R targets     │                      │
└──────────────────────┴──────────────────────┘
```

---

*Last Updated: 2025-11-28*  
*Auto-deployed via Vercel*

