# Quick Reference Guide

Fast lookup for the most commonly used values in the EditTrax design system.

## 🎨 Most Used Colors

```jsx
// Primary Theme
bg-black text-yellow-75          // Default dark theme

// Primary Buttons
bg-yellow-75 text-black          // Primary CTA
bg-yellow-125                    // Hover state

// Borders
border-2 border-black            // Standard border
border-2 border-yellow-75        // Accent border
```

### Color Variables
```
Yellow:  #E6E9E0 (yellow-75)     PRIMARY ACCENT
         #A6752B (yellow-125)     Hover state
Black:   #000000                  Primary background
Red:     #FC0023 (red-75)         Alerts/errors
Tezos:   #175C72                  Wallet buttons
```

## 📝 Typography Quick Pick

### Font Families
```jsx
font-mathias     // Headings, buttons, navigation, brand
font-Permanent   // Decorative, special emphasis
(default)        // Body text, descriptions
```

### Common Font Sizes
```jsx
text-xxs   // 0.6rem (9.6px)   - Tiny labels
text-xs    // 0.75rem (12px)   - Small text
text-sm    // 0.875rem (14px)  - Small body
text-base  // 1rem (16px)      - Body text
text-xl    // 1.25rem (20px)   - Subheadings
text-2xl   // 1.5rem (24px)    - Headings
text-4xl   // 2.25rem (36px)   - Large headings
```

### Line Heights
```jsx
leading-90       // 90% - Tight (Mathias font)
leading-none     // 100% - Very tight
leading-normal   // 150% - Body text
```

## 📐 Spacing Quick Pick

### Padding
```jsx
p-4      // 1rem (16px)    - Small containers
p-6      // 1.5rem (24px)  - Medium containers
p-10     // 2.5rem (40px)  - Large containers
```

### Margin
```jsx
mb-4     // 1rem (16px)    - Element spacing
mb-6     // 1.5rem (24px)  - Section spacing
mb-10    // 2.5rem (40px)  - Large breaks
```

### Gap
```jsx
gap-2    // 0.5rem (8px)   - Tight grids
gap-4    // 1rem (16px)    - Standard grids
gap-8    // 2rem (32px)    - Loose grids
```

## 🎯 Borders Quick Pick

```jsx
// Most Common Pattern
border-2 border-black

// Widths
border-0     // No border
border-2     // STANDARD (most common)
border-3     // Thick emphasis

// Radius
rounded-md   // 6px - Standard buttons
rounded-lg   // 8px - Cards
rounded-full // Circular
```

## 🌑 Shadows Quick Pick

```jsx
shadow-sm    // Subtle
shadow-lg    // Standard
shadow-2xl   // Elevated
shadow-5xl   // SIGNATURE BRAND (most common)
```

## 📱 Responsive Quick Pick

```jsx
// Breakpoints
sm:      // 640px
md:      // 768px
laptop:  // 920px (custom)
lg:      // 1024px
xl:      // 1280px

// Common Patterns
text-xl sm:text-2xl lg:text-4xl              // Responsive text
w-full sm:w-1/2 lg:w-1/3                     // Responsive width
flex flex-col md:flex-row                     // Responsive layout
p-4 sm:p-6 lg:p-10                           // Responsive padding
```

## 🔘 Button Recipes

### Primary CTA
```jsx
className="bg-yellow-75 text-black font-mathias px-6 py-3 rounded-md border-2 border-black shadow-2xl hover:bg-yellow-125 transition-all"
```

### Secondary Button
```jsx
className="bg-black text-yellow-75 font-mathias px-6 py-3 rounded-md border-2 border-yellow-75 shadow-lg hover:shadow-xl transition-all"
```

### Edit Button
```jsx
className="edit_button px-4 py-2"
// Or custom CSS class defined in component-patterns.md
```

## 📦 Card Recipe

```jsx
className="bg-black border-2 border-black rounded-md p-6 shadow-5xl"
```

## 📄 Text Recipes

### Section Heading
```jsx
className="font-mathias text-xl lg:text-3xl text-yellow-75 mb-6 uppercase"
```

### Body Text
```jsx
className="text-gray-400 text-sm lg:text-base leading-normal"
```

### Tight Line Height (Mathias)
```jsx
className="font-mathias leading-90"
```

## 🎭 Modal Recipe

```jsx
// Background
<div className="modal-bg">
  
  // Content
  <div className="modal-content">
    {/* Content here */}
  </div>
</div>

// Or use CSS classes from component-patterns.md
```

## 🔄 Transition Recipe

```jsx
// Standard
transition-all

// Custom
className="transition-all duration-300 ease-in-out"
```

## 🎪 Footer Recipe

```jsx
<footer className="bg-black p-10 lg:mt-18">
  <img src={logo} className="w-44" />
  {/* Footer content */}
</footer>
```

## 💾 Commonly Used Class Combinations

### Container
```
bg-black text-yellow-75 p-10 rounded-md shadow-5xl
```

### Interactive Element
```
cursor-pointer hover:shadow-xl transition-all duration-300
```

### Centered Layout
```
flex flex-col items-center justify-center
```

### Responsive Grid
```
grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4
```

### Full Width Section
```
w-full max-w-90vw mx-auto
```

## 🎨 State Classes

### Hover
```jsx
hover:bg-yellow-125
hover:shadow-xl
hover:scale-105
hover:underline
```

### Focus
```jsx
focus:outline-none
focus:ring-2
focus:ring-yellow-75
```

### Disabled
```jsx
disabled:opacity-25
disabled:cursor-not-allowed
```

## 🚀 Copy-Paste Templates

### Button
```jsx
<button className="bg-yellow-75 text-black font-mathias px-6 py-3 rounded-md border-2 border-black shadow-2xl hover:bg-yellow-125 transition-all">
  Click Me
</button>
```

### Card
```jsx
<div className="bg-black border-2 border-black rounded-md p-6 shadow-5xl">
  <h2 className="font-mathias text-xl text-yellow-75 mb-4">Title</h2>
  <p className="text-gray-400 text-sm">Content goes here</p>
</div>
```

### Input Field
```jsx
<input 
  type="text"
  className="bg-black text-yellow-75 border-2 border-yellow-75 rounded-md p-3 focus:outline-none focus:ring-2 focus:ring-yellow-75"
  placeholder="Enter text..."
/>
```

### Hero Section
```jsx
<section className="bg-black text-yellow-75 py-20 px-10">
  <h1 className="font-mathias text-4xl lg:text-6xl mb-6 leading-90">
    Hero Title
  </h1>
  <p className="text-lg lg:text-xl mb-8">
    Hero description text
  </p>
  <button className="bg-yellow-75 text-black font-mathias px-8 py-4 rounded-md shadow-2xl">
    Get Started
  </button>
</section>
```

### Grid Layout
```jsx
<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
  {/* Grid items */}
</div>
```

## 📋 Common CSS Classes

### From App.css
```
.centerHoriz          - Centered flex column
.font-mathias         - Mathias font family
.outline_button_main  - Primary button outline
.edit_button          - Edit button style
.modal                - Modal container
.modal-bg             - Modal background
.modal-content        - Modal content box
.releasePlayer        - Player container
.headline_hero        - Hero headline style
```

## 🎯 Design Principles

1. **Always black background** with light text
2. **Yellow-75 for accents** and CTAs
3. **Mathias font for brand** elements
4. **2px borders** as standard
5. **shadow-5xl** for depth
6. **Tight line-heights** (90-100%) for Mathias
7. **Mobile-first** responsive approach
8. **Consistent spacing** using defined scale

## 🔍 Quick Search Keywords

- **Primary color**: yellow-75 (#E6E9E0)
- **Background**: black (#000000)
- **Accent hover**: yellow-125 (#A6752B)
- **Standard border**: border-2 border-black
- **Standard radius**: rounded-md (6px)
- **Brand shadow**: shadow-5xl
- **Brand font**: font-mathias
- **Line height**: leading-90 (for Mathias)
- **Standard padding**: p-6
- **Section spacing**: mb-6

## 📱 Asset Paths

```
Fonts:     ./style-guide/fonts/mathias-bold.ttf
Logos:     ./style-guide/logos/
Images:    ./style-guide/images/
```

**Last Updated**: November 27, 2025

