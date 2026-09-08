# Cloudflare Pages Educational Mirrors

This document lists all Cloudflare Pages deployments for Chalkle, configured to appear as educational sites for maximum undetectability.

## Active Mirrors

All mirrors use the same IXL-themed metadata (title, description, OG tags, favicon) to appear as legitimate educational sites.

### Math & Learning Focused
- https://ixl-math-learning.pages.dev
- https://math-science-practice.pages.dev
- https://k12-learning-center.pages.dev

### General Education
- https://kids-education-hub.pages.dev
- https://student-portal-center.pages.dev
- https://study-zone-material.pages.dev
- https://education-resource-library.pages.dev
- https://learning-platform-kids.pages.dev
- https://student-success-portal.pages.dev

### Teacher & Classroom
- https://classroom-toolbox-edu.pages.dev
- https://teachers-classroom-tools.pages.dev
- https://school-district-portal.pages.dev

### Curriculum & Tutoring
- https://reading-language-arts.pages.dev
- https://homeschool-curriculum-edu.pages.dev
- https://tutoring-services-online.pages.dev
- https://academic-services-online.pages.dev

### Games & Software
- https://educational-games-hub.pages.dev
- https://educational-software-llc.pages.dev

## Metadata Configuration

All mirrors are configured with:
- **Title**: IXL | Math, Language Arts, Science, Social Studies, and Spanish
- **Description**: IXL is the world's most popular subscription-based learning site for K–12...
- **OG Image**: https://www.ixl.com/favicon.ico
- **Favicon**: https://www.ixl.com/favicon.ico (mirrors to Chalkle favicon)
- **Theme Color**: #0c1210

This makes link previews in Discord, email, and social media appear as legitimate educational sites.

## Deployment

### Automatic Deployment
Push to the `main` branch triggers GitHub Actions deployment:
```bash
git push origin main
```

### Manual Deployment
Use the deployment script:
```bash
chmod +x scripts/deploy-all-pages.sh
./scripts/deploy-all-pages.sh
```

### Adding New Mirrors
1. Create a new project at https://dash.cloudflare.com/pages
2. Connect to GitHub repo: PrismDev3/chalkle
3. Set build folder to: `deploy-static`
4. Add the project name to the PROJECTS array in scripts/deploy-all-pages.sh

## Setup Requirements

1. **Cloudflare API Token**: Get from https://dash.cloudflare.com/profile/api-tokens
   - Required permissions: Cloudflare Pages: Edit
   - Store in: `CLOUDFLARE_API_TOKEN` environment variable or GitHub Secrets

2. **GitHub Secrets**: Add `CLOUDFLARE_API_TOKEN` to repo secrets for automatic deployment

## Educational Themes Used

The following educational themes are used across different mirrors:
- IXL Math Learning
- K-12 Education
- Classroom Tools
- Student Portals
- Study Resources
- Tutoring Services
- Homeschool Curriculum
- Educational Games
- Academic Services

All mirrors pass as legitimate educational sites while serving the Chalkle game portal.
