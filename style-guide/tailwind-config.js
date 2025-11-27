/**
 * EditTrax Design System - Tailwind Configuration
 * 
 * This configuration extends Tailwind CSS with custom design tokens
 * from the EditTrax brand. Drop this file into your project as
 * tailwind.config.js to apply the complete design system.
 * 
 * Requirements:
 * - tailwindcss@npm:@tailwindcss/postcss7-compat@^2.2.17
 * - autoprefixer@^9.8.8
 * - postcss@^7.0.39
 * 
 * Usage:
 * 1. Copy this file to your project root as tailwind.config.js
 * 2. Update the purge paths to match your project structure
 * 3. Import the Mathias font in your CSS
 * 4. Add Google Fonts link for Permanent Marker if needed
 */

module.exports = {
  // Update these paths to match your project structure
  purge: ['./src/**/*.{js,jsx,ts,tsx}', './public/index.html'],
  
  darkMode: false, // or 'media' or 'class'
  
  theme: {
    extend: {
      // ========================================
      // TYPOGRAPHY
      // ========================================
      
      fontFamily: {
        // Primary brand font (requires local font file)
        mathias: ["Mathias", "sans-serif"],
        
        // Secondary decorative font (Google Font)
        Permanent: ["Permanent Marker", "cursive"],
      },
      
      fontSize: {
        xxs: '0.6rem',      // 9.6px - Extra small labels
        // Standard Tailwind sizes are preserved
      },
      
      lineHeight: {
        '90': '90%',        // Tight line height for player text
        '500': '-5px',      // Custom negative (use carefully)
      },
      
      // ========================================
      // SPACING
      // ========================================
      
      spacing: {
        '0.8': '0.3rem',    // ~5px - Extra tight spacing
        '9.5': '2.3rem',    // ~37px - Custom gap
      },
      
      margin: {
        '-top-160': '-160px',
        'customMarginBottom': '119px',
      },
      
      // ========================================
      // SIZING
      // ========================================
      
      width: {
        100: '28rem',       // 448px
        110: '35rem',       // 560px
        120: '45rem',       // 720px
        473: '473px',       // Fixed size
        90: '90vw',         // Responsive viewport
        91: '90%',          // Percentage
        101: '101%',        // Slight overflow
      },
      
      height: {
        473: '473px',
        970: '970px',
        410: '410px',
      },
      
      // ========================================
      // COLORS
      // ========================================
      
      colors: {
        // Purple shades
        purple: {
          1000: '#936984',
        },
        
        // Blue shades - Primary dark theme colors
        blue: {
          450: '#3481F0',   // Accent blue
          460: '#37AEC4',   // Teal accent
          810: '#1C1C33',   // Dark blue background
          820: '#353554',   // Medium dark blue
          830: '#14142B',   // Darker blue
          840: '#05050F',   // Almost black blue
          850: '#1F1F1F',   // Dark gray-blue
          900: '#170E1E',   // Darkest purple-blue
        },
        
        // Gray shades
        gray: {
          660: '#373737',   // Medium gray
          760: '#282828',   // Dark gray
        },
        
        // Red shades
        red: {
          75: '#FC0023',    // Error, alert red
        },
        
        // Yellow shades - Primary accent colors
        yellow: {
          75: '#E6E9E0',    // PRIMARY ACCENT - Text highlights, CTAs
          125: '#A6752B',   // Hover states, secondary accent
        },
        
        // Orange shades
        orange: {
          900: '#8D713F',   // Accent orange
        },
        
        // Brown shades
        brown: {
          100: '#AC3434',   // Accent brown/red
        },
      },
      
      // ========================================
      // EFFECTS
      // ========================================
      
      boxShadow: {
        // Custom signature shadow for brand depth
        '5xl': '3px 3px 10px rgba(0, 0, 0, 0.6), -3px -3px 10px rgba(0, 0, 0, 0.6)',
      },
      
      // ========================================
      // RESPONSIVE
      // ========================================
      
      screens: {
        // Custom laptop breakpoint
        'laptop': '920px',
        // Standard Tailwind breakpoints are preserved:
        // sm: 640px
        // md: 768px
        // lg: 1024px
        // xl: 1280px
        // 2xl: 1536px
      },
      
      // ========================================
      // VARIANTS
      // ========================================
      
      variants: {
        backgroundColor: ['responsive', 'even'],
      },
    },
  },
  
  variants: {
    extend: {},
  },
  
  plugins: [],
}

/**
 * COLOR USAGE GUIDE:
 * 
 * Primary Palette:
 * - bg-black + text-yellow-75: Default theme (black bg, light text)
 * - bg-yellow-75 + text-black: Primary CTAs and buttons
 * - bg-yellow-125: Hover states for yellow buttons
 * 
 * Secondary Palette:
 * - bg-blue-900: Alternative dark backgrounds
 * - text-gray-660: Secondary text, less emphasis
 * - bg-red-75: Error states, alerts
 * 
 * Special Use:
 * - purple-1000: Accent highlights
 * - orange-900, brown-100: Specific brand applications
 * 
 * =====================================
 * 
 * FONT USAGE GUIDE:
 * 
 * font-mathias:
 * - All headings (h1, h2, h3, etc.)
 * - Navigation items
 * - Buttons and CTAs
 * - Brand-specific text
 * - Use with tight line-height (leading-90)
 * 
 * font-Permanent:
 * - Special decorative text
 * - Callouts and highlights
 * - Limited use for emphasis
 * 
 * Default (system):
 * - Body text
 * - Descriptions
 * - User-generated content
 * - Forms and inputs
 * 
 * =====================================
 * 
 * SPACING USAGE:
 * 
 * Padding:
 * - p-4: Small containers (16px)
 * - p-6: Medium containers (24px)
 * - p-10: Large containers (40px)
 * 
 * Margin:
 * - mb-4, mt-4: Standard spacing between elements
 * - mb-6, mt-6: Spacing between sections
 * - mb-10, mt-10: Large section breaks
 * 
 * Gap:
 * - gap-2, gap-4: Grid/flex item spacing
 * - gap-8: Large grid spacing
 * 
 * =====================================
 * 
 * BORDER USAGE:
 * 
 * Border Width:
 * - border-0: No border
 * - border-2: Standard border (MOST COMMON)
 * - border-3: Thick border for emphasis
 * 
 * Border Radius:
 * - rounded-md: Standard buttons, small cards (6px)
 * - rounded-lg: Larger cards (8px)
 * - rounded-full: Circular elements
 * 
 * Border Colors:
 * - border-black: Default (2px solid black)
 * - border-yellow-75: Accent borders
 * 
 * =====================================
 * 
 * SHADOW USAGE:
 * 
 * - shadow-sm: Subtle depth
 * - shadow-lg: Standard cards
 * - shadow-2xl: Elevated elements
 * - shadow-5xl: SIGNATURE BRAND SHADOW (most common)
 * 
 * =====================================
 * 
 * RESPONSIVE PATTERNS:
 * 
 * Mobile-first approach:
 * 
 * Text:
 * - text-xl sm:text-2xl lg:text-4xl
 * 
 * Layout:
 * - flex flex-col md:flex-row
 * - w-full sm:w-1/2 laptop:w-1/3 lg:w-1/4
 * 
 * Spacing:
 * - p-4 sm:p-6 lg:p-10
 * - gap-2 sm:gap-4 lg:gap-8
 * 
 * =====================================
 */

