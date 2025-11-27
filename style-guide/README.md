# EditTrax Design System Style Guide

This style guide contains all the design tokens, assets, and guidelines used in the EditTrax dApp. It can be easily applied to other projects using the provided configuration files and references.

## 📁 Folder Structure

```
style-guide/
├── README.md                    # This file - overview and usage instructions
├── design-tokens.md             # All design tokens (colors, spacing, typography, etc.)
├── component-patterns.md        # Reusable component styling patterns
├── tailwind-config.js           # Ready-to-use Tailwind configuration
├── css-variables.css            # CSS custom properties version
├── fonts/                       # Custom fonts
│   └── mathias-bold.ttf        # Primary brand font
├── logos/                       # Brand logos
│   ├── logo.svg                # Favicon/icon logo
│   ├── et_horizontal.png       # Horizontal layout logo
│   └── et_new_logo.png         # New version logo
└── images/                      # Key background/splash images
    ├── homepage_bg.png         # Homepage background
    ├── loader_bg.png           # Loading screen background
    ├── banner_homepage.png     # Banner image
    ├── banner_homepage-2.png   # Alternative banner
    └── homepage_c.jpg          # Homepage cover image
```

## 🚀 Quick Start

### For New Projects

1. **Copy the entire `style-guide` folder** to your new project
2. **Install dependencies**:
   ```bash
   npm install -D tailwindcss@npm:@tailwindcss/postcss7-compat@^2.2.17 autoprefixer@^9.8.8 postcss@^7.0.39
   ```
3. **Copy the Tailwind configuration**:
   ```bash
   cp style-guide/tailwind-config.js ./tailwind.config.js
   ```
4. **Import fonts in your main CSS file**:
   ```css
   @font-face {
     font-family: mathias;
     src: url(./style-guide/fonts/mathias-bold.ttf);
   }
   ```
5. **Reference the design tokens** from `design-tokens.md` for consistency

### For Cursor AI Integration

When working with Cursor, you can reference this style guide by:
- Opening the `design-tokens.md` file for all color, spacing, and typography values
- Referencing `component-patterns.md` for reusable component styles
- Using the `tailwind-config.js` as a template for Tailwind customization

## 📚 Documentation Files

- **design-tokens.md**: Complete reference of all design values (colors, fonts, spacing, borders, shadows)
- **component-patterns.md**: Common component styling patterns with examples
- **tailwind-config.js**: Drop-in Tailwind configuration
- **css-variables.css**: Alternative implementation using CSS custom properties

## 🎨 Key Design Principles

1. **Dark Theme First**: Primary background is black (#000000)
2. **Accent Color**: Yellow-75 (#E6E9E0) for highlights and interactive elements
3. **Custom Typography**: Mathias font for headings and brand elements
4. **Minimal Borders**: Primarily 2px solid borders, rounded corners at 5px
5. **Shadow Depth**: Uses custom shadow-5xl for depth (3px 3px 10px rgba(0,0,0,0.6))

## 🔧 Technology Stack

- **CSS Framework**: Tailwind CSS (PostCSS 7 compatible)
- **Custom Fonts**: Mathias Bold, Permanent Marker (Google Fonts)
- **UI Library**: React with Material-UI and Headless UI components
- **Icons**: Phosphor React, React Icons, Font Awesome

## 📝 Usage Examples

### Applying Brand Colors
```jsx
// Primary button
<button className="bg-yellow-75 text-black hover:bg-yellow-125">
  Click Me
</button>

// Accent text
<h1 className="text-yellow-75 font-mathias">
  EditTrax
</h1>
```

### Using Custom Fonts
```jsx
// Mathias font for headings
<h1 className="font-mathias text-xl">
  Heading
</h1>

// Permanent Marker for special text
<span className="font-Permanent">
  Special Text
</span>
```

### Common Layout Pattern
```jsx
<div className="bg-black text-yellow-75 p-10 rounded-md border-2 border-black shadow-5xl">
  {/* Content */}
</div>
```

## 🎯 Brand Assets Usage

### Logos
- **logo.svg**: Use for favicons, small icons (16x16, 32x32)
- **et_horizontal.png**: Use for navigation bars, footers (width: 176px / 11rem)
- **et_new_logo.png**: Use for hero sections, large displays

### Background Images
- **homepage_bg.png**: Main homepage slider background
- **loader_bg.png**: Loading screens (center, contain, no-repeat)
- **banner_homepage.png**: Banner sections (center, cover, no-repeat)
- **homepage_c.jpg**: Alternative homepage cover

## 📐 Responsive Breakpoints

- **Mobile**: Default (< 640px)
- **Tablet**: sm: 640px
- **Laptop**: laptop: 920px (custom)
- **Desktop**: lg: 1024px
- **XL**: xl: 1280px

## 🔄 Version Control

When updating this style guide:
1. Document all changes in this README
2. Update the relevant .md files
3. Ensure backward compatibility or provide migration notes
4. Update the version date below

**Last Updated**: November 27, 2025
**Version**: 1.0.0

## 📞 Contact

For questions about this design system, contact: edittrax@protonmail.com

