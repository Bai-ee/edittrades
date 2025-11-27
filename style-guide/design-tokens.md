# Design Tokens

Complete reference of all design values used in the EditTrax design system.

## 🎨 Color Palette

### Primary Colors
```css
--color-black: #000000;           /* Primary background */
--color-white: #FFFFFF;           /* Text on dark backgrounds */
```

### Brand Colors (Yellow)
```css
--yellow-75: #E6E9E0;            /* Primary accent, text highlights */
--yellow-125: #A6752B;           /* Hover states, secondary accent */
```

### Blue Shades
```css
--blue-450: #3481F0;             /* Accent blue */
--blue-460: #37AEC4;             /* Teal accent */
--blue-810: #1C1C33;             /* Dark blue background */
--blue-820: #353554;             /* Medium dark blue */
--blue-830: #14142B;             /* Darker blue */
--blue-840: #05050F;             /* Almost black blue */
--blue-850: #1F1F1F;             /* Dark gray-blue */
--blue-900: #170E1E;             /* Darkest purple-blue (duplicate key, latest wins) */
```

### Purple Shades
```css
--purple-1000: #936984;          /* Accent purple */
```

### Gray Shades
```css
--gray-660: #373737;             /* Medium gray */
--gray-760: #282828;             /* Dark gray */
```

### Red Shades
```css
--red-75: #FC0023;               /* Error, alert red */
```

### Orange & Brown
```css
--orange-900: #8D713F;           /* Accent orange */
--brown-100: #AC3434;            /* Accent brown/red */
```

### Functional Colors
```css
--checkout-bg: #8EA461;          /* Checkout button background */
--soldout-bg: #373935;           /* Sold out state background */
--tezos-wallet-bg: #175C72;      /* Tezos wallet button background */
--edit-button-bg: #99854E;       /* Edit button background */
```

## 📝 Typography

### Font Families

#### Primary Font (Mathias)
```css
font-family: mathias;
src: url(./fonts/mathias-bold.ttf);
```
**Usage**: Headings, buttons, brand elements, navigation
**Weight**: Bold (only weight available)

#### Secondary Font (Permanent Marker)
```css
font-family: "Permanent Marker";  /* Google Font */
```
**Usage**: Special decorative text, callouts
**Import**: Include from Google Fonts

#### System Font Stack
```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
```
**Usage**: Body text, descriptions, general content

### Font Sizes

```css
--text-xxs: 0.6rem;              /* 9.6px - Very small labels */
--text-xs: 0.75rem;              /* 12px - Small text */
--text-sm: 0.875rem;             /* 14px - Small body text */
--text-base: 1rem;               /* 16px - Body text */
--text-lg: 1.125rem;             /* 18px - Large body */
--text-xl: 1.25rem;              /* 20px - Headings */
--text-2xl: 1.5rem;              /* 24px - Large headings */
--text-3xl: 1.875rem;            /* 30px - Hero text */
--text-4xl: 2.25rem;             /* 36px - Display */
```

### Line Heights

```css
--leading-none: 1;               /* 100% - Tight text */
--leading-tight: 1.25;           /* 125% */
--leading-normal: 1.5;           /* 150% - Default */
--leading-90: 90%;               /* Custom tight for player text */
--leading-500: -5px;             /* Custom negative (use cautiously) */

/* Custom classes */
.custom-line-height: 100%;       /* 14px font size */
.headline_hero: 30px;            /* Hero headlines */
.playerTextLineHeight: 90% !important;
```

### Font Weights

```css
--font-normal: 400;
--font-medium: 500;
--font-semibold: 600;
--font-bold: 700;
```

## 📏 Spacing Scale

### Tailwind Spacing Extensions
```css
--spacing-0.8: 0.3rem;           /* ~5px - Extra tight */
--spacing-9.5: 2.3rem;           /* ~37px - Custom gap */

/* Standard Tailwind scale is preserved */
--spacing-1: 0.25rem;            /* 4px */
--spacing-2: 0.5rem;             /* 8px */
--spacing-3: 0.75rem;            /* 12px */
--spacing-4: 1rem;               /* 16px */
--spacing-5: 1.25rem;            /* 20px */
--spacing-6: 1.5rem;             /* 24px */
--spacing-8: 2rem;               /* 32px */
--spacing-10: 2.5rem;            /* 40px */
--spacing-12: 3rem;              /* 48px */
--spacing-16: 4rem;              /* 64px */
--spacing-20: 5rem;              /* 80px */
--spacing-24: 6rem;              /* 96px */
```

### Custom Margins
```css
--margin-top-negative-160: -160px;
--margin-bottom-custom: 119px;
```

## 📐 Layout & Sizing

### Widths
```css
--width-100: 28rem;              /* 448px */
--width-110: 35rem;              /* 560px */
--width-120: 45rem;              /* 720px */
--width-473: 473px;              /* Fixed size */
--width-90: 90vw;                /* Responsive viewport */
--width-91: 90%;                 /* Percentage */
--width-101: 101%;               /* Slight overflow */
```

### Heights
```css
--height-473: 473px;
--height-970: 970px;
--height-410: 410px;
```

### Media Player Sizes
```css
--player-width: 105px;
--player-height: 32px;
--audio-player-container: 40px × 40px;
--audio-player-border-radius: 27px;
```

## 🎯 Borders

### Border Widths
```css
--border-0: 0px;                 /* No border */
--border-1: 1px;                 /* Thin border */
--border-2: 2px;                 /* Standard border (most common) */
--border-3: 3px;                 /* Thick border */
```

### Border Radius
```css
--rounded-none: 0;
--rounded-sm: 0.125rem;          /* 2px */
--rounded-md: 0.375rem;          /* 6px - Most common */
--rounded-lg: 0.5rem;            /* 8px */
--rounded-xl: 0.75rem;           /* 12px */
--rounded-full: 9999px;          /* Circular */

/* Custom values */
--rounded-5: 5px;                /* Standard buttons */
--rounded-10: 10px;              /* Cards */
--rounded-27: 27px;              /* Audio player */
--rounded-50: 50px;              /* Circular buttons */
```

## 🌑 Shadows

### Custom Shadow
```css
--shadow-5xl: 3px 3px 10px rgba(0, 0, 0, 0.6), -3px -3px 10px rgba(0, 0, 0, 0.6);
```
**Usage**: Primary depth shadow for cards, modals, elevated elements

### Standard Shadows (Tailwind)
```css
--shadow-sm: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
--shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06);
--shadow-md: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
--shadow-lg: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
--shadow-xl: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
--shadow-2xl: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
--shadow-4xl: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
```

### Box Shadow Patterns
```css
/* Google button style */
box-shadow: 0 -1px 0 rgba(0, 0, 0, .04), 0 1px 1px rgba(0, 0, 0, .25);

/* Hover state */
box-shadow: 0 -1px 0 rgba(0, 0, 0, .04), 0 2px 4px rgba(0, 0, 0, .25);

/* Focus state */
box-shadow: 
  0 -1px 0 rgba(0, 0, 0, .04),
  0 2px 4px rgba(0, 0, 0, .25),
  0 0 0 3px #c8dafc;
```

## 📱 Responsive Breakpoints

```css
/* Tailwind Default */
--screen-sm: 640px;              /* Tablet */
--screen-md: 768px;              /* Landscape tablet */
--screen-lg: 1024px;             /* Desktop */
--screen-xl: 1280px;             /* Large desktop */
--screen-2xl: 1536px;            /* Extra large */

/* Custom Breakpoint */
--screen-laptop: 920px;          /* Custom laptop breakpoint */
```

### Usage Examples
```jsx
// Mobile first approach
<div className="w-full sm:w-1/2 laptop:w-1/3 lg:w-1/4">
```

## 🎭 Opacity Values

```css
--opacity-25: 0.25;              /* Muted/disabled state */
--opacity-50: 0.5;               /* Semi-transparent */
--opacity-75: 0.75;              /* Slightly transparent */
--opacity-100: 1;                /* Fully opaque */
```

### Background Opacity
```css
/* Modal backgrounds */
--modal-bg-opacity: rgba(0, 0, 0, 0.78);
--modal-bg-signin: rgb(0, 0, 0);  /* Solid black */
```

## 🎪 Z-Index Scale

```css
--z-0: 0;                        /* Default */
--z-10: 10;                      /* Modals, overlays */
--z-9999: 9999;                  /* Modal content, tooltips */
--z-auto: auto;
```

## ⚡ Transitions

```css
/* Standard transition */
transition: background-color .3s, box-shadow .3s;

/* Max-height collapse */
transition: max-height .5s ease;

/* Transform transitions */
transition: all 0.3s ease;
```

## 🖼️ Background Patterns

### Background Image Positioning
```css
/* Standard pattern */
background-position: center;
background-size: cover;          /* For full coverage */
background-size: contain;        /* For maintaining aspect ratio */
background-repeat: no-repeat;

/* Specific positioning */
background-position: 15px 25px;  /* Google button icon */
background-position: 5px;        /* Player elements */
```

## 📊 Common Value Combinations

### Button Style
```css
border: solid 2px black;
border-radius: 5px;
padding: 0.5rem 1rem;
font-family: mathias;
background-color: #E6E9E0;
color: black;
box-shadow: 0 -1px 0 rgba(0, 0, 0, .04), 0 1px 1px rgba(0, 0, 0, .25);
```

### Card Style
```css
background-color: black;
border: solid 2px black;
border-radius: 10px;
padding: 1rem;
box-shadow: 3px 3px 10px rgba(0, 0, 0, 0.6), -3px -3px 10px rgba(0, 0, 0, 0.6);
```

### Modal Style
```css
position: fixed;
top: 0;
left: 0;
width: 100%;
height: 100vh;
z-index: 10;
background-color: rgba(0, 0, 0, 0.78);
display: flex;
align-items: center;
justify-content: center;
```

## 📝 Usage Notes

1. **Always use Mathias font** for brand-related text (headings, buttons, navigation)
2. **Yellow-75 (#E6E9E0)** is the primary accent color - use for CTAs and highlights
3. **2px borders** are standard - use consistently across UI elements
4. **5px border-radius** is the standard for buttons and small elements
5. **10px border-radius** for cards and larger containers
6. **shadow-5xl** is the signature depth shadow for the brand
7. **Black backgrounds** with light text is the default theme
8. **Line heights should be tight** (90-100%) for Mathias font to maintain brand style

## 🔄 Token Updates

When updating tokens:
1. Ensure backward compatibility
2. Document the change reason
3. Update this file and the Tailwind config
4. Test across all breakpoints

**Last Updated**: November 27, 2025

