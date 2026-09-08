#!/usr/bin/env node

/**
 * Setup Cloudflare Pages projects for Chalkle
 * Creates multiple educational-themed mirrors
 */

const projects = [
  { name: 'ixl-math-learning', display: 'IXL Math Learning - K-12 Practice' },
  { name: 'kids-education-hub', display: 'Kids Education Hub - Learning Games' },
  { name: 'student-portal-center', display: 'Student Portal Center - School Resources' },
  { name: 'classroom-toolbox-edu', display: 'Classroom Toolbox - Educational Tools' },
  { name: 'academic-services-online', display: 'Academic Services - Online Learning' },
  { name: 'study-zone-material', display: 'Study Zone - Learning Materials' },
  { name: 'education-resource-library', display: 'Education Resource Library' },
  { name: 'teachers-classroom-tools', display: 'Teachers Classroom Tools' },
  { name: 'school-district-portal', display: 'School District Portal' },
  { name: 'learning-platform-kids', display: 'Learning Platform for Kids' },
];

console.log('Cloudflare Pages Project Setup');
console.log('===============================\n');
console.log('This script will help you create multiple Cloudflare Pages projects.');
console.log('You\'ll need to create them manually or via the Cloudflare Dashboard.\n');

console.log('Recommended Project Names (educational-themed):');
console.log('----------------------------------------------');
projects.forEach((p, i) => {
  console.log(`${i + 1}. ${p.name}`);
  console.log(`   Display: ${p.display}`);
  console.log(`   URL:     https://${p.name}.pages.dev`);
  console.log('');
});

console.log('\nSetup Instructions:');
console.log('-------------------');
console.log('1. Go to https://dash.cloudflare.com/pages');
console.log('2. Click "Create a project" → "Connect to Git"');
console.log('3. Select your GitHub repo: PrismDev3/chalkle');
console.log('4. Choose the "deploy-static" folder as the build output');
console.log('5. Name the project (use one from the list above)');
console.log('6. Click "Begin deployment"');
console.log('');
console.log('Repeat for each project you want to create.');
console.log('');
console.log('After creating all projects, add this to your .env:');
console.log('CLOUDFLARE_API_TOKEN=your_api_token_here');
console.log('');
console.log('Get your API token at: https://dash.cloudflare.com/profile/api-tokens');
console.log('Required permissions: Cloudflare Pages: Edit');
