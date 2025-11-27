# Asset Catalog

Complete inventory of all design assets included in the EditTrax style guide.

## 📁 Folder Structure

```
style-guide/
├── fonts/                   # Custom typography
├── logos/                   # Brand logos and icons
├── images/                  # Key backgrounds and splash images
└── [documentation files]
```

## 🔤 Fonts

### Mathias Bold
**File:** `fonts/mathias-bold.ttf`
**Format:** TrueType Font (.ttf)
**Weight:** Bold
**Style:** Normal

**Usage:**
```css
@font-face {
  font-family: "Mathias";
  src: url('./fonts/mathias-bold.ttf') format('truetype');
  font-weight: bold;
  font-style: normal;
  font-display: swap;
}
```

**Apply:**
```css
.font-mathias {
  font-family: "Mathias", sans-serif;
}
```

**Best For:**
- Headings (H1-H6)
- Buttons and CTAs
- Navigation items
- Brand elements
- Labels
- Any text that needs brand presence

**Line Height Recommendation:** 90-100% (tight) - Use `leading-90` or `leading-none`

**Not Recommended For:**
- Body paragraphs (use system font stack)
- Long-form content
- User-generated content

### Permanent Marker (Google Font)
**Source:** Google Fonts
**Link:** https://fonts.google.com/specimen/Permanent+Marker

**Import:**
```html
<link href="https://fonts.googleapis.com/css2?family=Permanent+Marker&display=swap" rel="stylesheet">
```

**Usage:**
```css
.font-Permanent {
  font-family: "Permanent Marker", cursive;
}
```

**Best For:**
- Special decorative text
- Callouts
- Limited emphasis
- Hero taglines

**Use Sparingly** - This font is for accent only

## 🎨 Logos

### logo.svg
**File:** `logos/logo.svg`
**Format:** SVG (Scalable Vector Graphics)
**Color:** Monochrome (adaptable)
**Aspect Ratio:** Square/Icon format

**Usage:**
- Favicon (16x16, 32x32, 48x48)
- App icons
- Social media profile pictures
- Small icon representations

**Implementation:**
```html
<!-- Favicon -->
<link rel="icon" href="/logos/logo.svg" />

<!-- Inline -->
<img src="/logos/logo.svg" alt="EditTrax" width="32" height="32" />
```

**Tailwind Classes:**
```jsx
<img src={logoSvg} alt="EditTrax" className="w-8 h-8" />
```

### et_horizontal.png
**File:** `logos/et_horizontal.png`
**Format:** PNG
**Layout:** Horizontal/Wide
**Transparency:** Yes
**Recommended Display Width:** 176px (w-44 in Tailwind)

**Usage:**
- Navigation bars
- Website headers
- Email signatures
- Footer sections
- Presentations

**Implementation:**
```jsx
<img 
  src="/logos/et_horizontal.png" 
  alt="EditTrax" 
  className="w-44 mb-8 sm:mb-0 mt-8 sm:w-44"
/>
```

**Responsive Sizing:**
- Mobile: w-42 (168px)
- Desktop: w-44 (176px)

**Background:** Works best on dark backgrounds

### et_new_logo.png
**File:** `logos/et_new_logo.png`
**Format:** PNG
**Layout:** Logo mark + wordmark
**Transparency:** Yes

**Usage:**
- Hero sections
- Large displays
- Landing pages
- Marketing materials
- Print applications

**Implementation:**
```jsx
<img 
  src="/logos/et_new_logo.png" 
  alt="EditTrax" 
  className="w-64 lg:w-96"
/>
```

**Sizing Guidelines:**
- Minimum width: 200px
- Recommended: 256px-384px
- Maximum: No limit (it's a logo, keep it reasonable)

**Background:** Optimized for dark backgrounds

## 🖼️ Images

### homepage_bg.png
**File:** `images/homepage_bg.png`
**Format:** PNG
**Purpose:** Homepage slider/carousel background
**Dimensions:** [Check actual dimensions]

**Usage:**
```css
.homepage-slider {
  background-image: url('/images/homepage_bg.png');
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}
```

**Tailwind Implementation:**
```jsx
<div 
  className="min-h-screen bg-center bg-cover bg-no-repeat"
  style={{ backgroundImage: "url('/images/homepage_bg.png')" }}
>
  {/* Content */}
</div>
```

**Best For:**
- Homepage hero sections
- Full-screen backgrounds
- Slider backgrounds

### loader_bg.png
**File:** `images/loader_bg.png`
**Format:** PNG
**Purpose:** Loading screen background

**Usage:**
```css
.loader-screen {
  background-image: url('/images/loader_bg.png');
  background-position: center;
  background-size: contain;
  background-repeat: no-repeat;
}
```

**Best For:**
- Loading screens
- Splash screens
- Initialization states

**Note:** Uses `contain` instead of `cover` to maintain aspect ratio

### banner_homepage.png
**File:** `images/banner_homepage.png`
**Format:** PNG
**Purpose:** Banner section background
**Recommended Height:** 30vh

**Usage:**
```css
.banner {
  background-image: url('/images/banner_homepage.png');
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  height: 30vh;
  max-width: 100%;
}
```

**Best For:**
- Page section banners
- Feature highlights
- Content dividers

### banner_homepage-2.png
**File:** `images/banner_homepage-2.png`
**Format:** PNG
**Purpose:** Alternative banner background

**Usage:** Same as banner_homepage.png
**Use Case:** A/B testing, seasonal variations, alternate pages

### homepage_c.jpg
**File:** `images/homepage_c.jpg`
**Format:** JPEG
**Purpose:** Homepage cover/banner
**Optimization:** Compressed for web

**Usage:**
```css
.banner {
  background-image: url('/images/homepage_c.jpg');
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  height: 30vh;
}
```

**Best For:**
- Banner sections
- Cover images
- Background variety

**Note:** JPEG format - better for photographs, smaller file size than PNG

## 📐 Asset Usage Guidelines

### Logo Usage Rules

**DO:**
- ✅ Maintain aspect ratio
- ✅ Use on appropriate backgrounds (dark preferred)
- ✅ Provide adequate clear space
- ✅ Scale proportionally
- ✅ Use provided file formats

**DON'T:**
- ❌ Stretch or distort
- ❌ Change colors (unless specified)
- ❌ Add effects (shadows, gradients) without approval
- ❌ Rotate or skew
- ❌ Place on busy backgrounds

### Image Usage Rules

**DO:**
- ✅ Optimize for web (compress appropriately)
- ✅ Use lazy loading for performance
- ✅ Provide alt text for accessibility
- ✅ Use appropriate background properties
- ✅ Test on different screen sizes

**DON'T:**
- ❌ Use full resolution unnecessarily
- ❌ Forget responsive behavior
- ❌ Omit accessibility considerations
- ❌ Ignore loading performance

### Font Usage Rules

**DO:**
- ✅ Use Mathias for brand elements
- ✅ Maintain tight line-height with Mathias
- ✅ Load fonts with font-display: swap
- ✅ Provide fallback fonts
- ✅ Subset fonts if possible for performance

**DON'T:**
- ❌ Use Mathias for body text
- ❌ Mix too many font families
- ❌ Ignore font loading performance
- ❌ Override line-height inappropriately

## 🚀 Implementation Checklist

### Setting Up Fonts
- [ ] Copy mathias-bold.ttf to project
- [ ] Add @font-face declaration
- [ ] Import Google Font (Permanent Marker)
- [ ] Test font loading
- [ ] Add fallback fonts
- [ ] Verify rendering across browsers

### Setting Up Logos
- [ ] Copy all logo files to public/assets or appropriate folder
- [ ] Update favicon references in HTML
- [ ] Implement navigation logo
- [ ] Implement footer logo
- [ ] Add proper alt text
- [ ] Test responsive sizing

### Setting Up Images
- [ ] Copy all background images
- [ ] Optimize images for web
- [ ] Implement background styles
- [ ] Add loading states
- [ ] Test responsive behavior
- [ ] Verify performance impact

## 📊 Asset Performance

### File Sizes
```
Fonts:
- mathias-bold.ttf: ~[Check actual size]

Logos:
- logo.svg: ~[Check actual size]
- et_horizontal.png: ~[Check actual size]
- et_new_logo.png: ~[Check actual size]

Images:
- homepage_bg.png: ~[Check actual size]
- loader_bg.png: ~[Check actual size]
- banner_homepage.png: ~[Check actual size]
- banner_homepage-2.png: ~[Check actual size]
- homepage_c.jpg: ~[Check actual size]
```

### Optimization Tips

**Fonts:**
- Use woff2 format for better compression (if converting)
- Subset fonts to include only needed characters
- Load fonts asynchronously

**Images:**
- Use WebP format for better compression (with fallbacks)
- Implement responsive images (srcset)
- Use CDN for serving assets
- Enable lazy loading
- Consider using next-gen formats

**Logos:**
- SVG is ideal for logos (scalable, small size)
- For PNGs, export at 2x resolution for retina displays
- Use PNG-8 if transparency + simple colors
- Use PNG-24 for complex transparency

## 🔄 Updating Assets

When updating assets in the style guide:

1. **Add new asset** to appropriate folder
2. **Update this catalog** with new asset info
3. **Document usage** patterns
4. **Update version** in README.md
5. **Notify team** of changes
6. **Update dependent projects** as needed

## 📱 Export Settings

### For New Logos (Design Team)
- **SVG:** Optimize, remove unnecessary metadata
- **PNG:** 2x resolution, transparent background, PNG-24
- **Naming:** lowercase, descriptive, no spaces (use underscores)

### For New Images
- **Format:** PNG for transparency, JPEG for photos
- **Compression:** Optimize for web (70-85% quality for JPEG)
- **Naming:** descriptive, consistent with existing patterns
- **Dimensions:** Appropriate for use case, consider mobile

### For New Fonts
- **Format:** TrueType (.ttf) or Web Font (.woff2)
- **License:** Verify usage rights
- **Documentation:** Include font family, weights, styles available
- **Fallbacks:** Specify appropriate fallback fonts

## 📞 Asset Questions?

If you need:
- **Different formats** of existing assets
- **Additional variations** (colors, sizes)
- **New assets** for specific use cases
- **Higher resolution** versions
- **Print-ready** versions

Contact: edittrax@protonmail.com

## 📝 Asset Changelog

### Version 1.0.0 (November 27, 2025)
- Initial asset catalog
- Added Mathias Bold font
- Added 3 logo variations
- Added 5 background/splash images
- Documented usage guidelines

---

**Last Updated**: November 27, 2025
**Catalog Version**: 1.0.0

