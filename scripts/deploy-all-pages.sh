#!/bin/bash

# Deploy Chalkle to all Cloudflare Pages projects
# Run this after pushing to main to deploy to all educational mirrors

TOKEN="${CLOUDFLARE_API_TOKEN:-cfoat_vC-2tMKlNjcy8rXk07zoBXct46ov7zleTXy3oLim7yk.Bsm7svVix9H3yy_7NYxOoRoQNfdP0YsAs3Josu6_Rm0}"
ACCOUNT="24daff7bc56afcdf6dbcb94e94460700"
BRANCH="main"

echo "=========================================="
echo "Deploying Chalkle to Cloudflare Pages"
echo "=========================================="
echo ""

# List of all educational-themed projects
PROJECTS=(
  "ixl-math-learning"
  "kids-education-hub"
  "student-portal-center"
  "classroom-toolbox-edu"
  "academic-services-online"
  "study-zone-material"
  "education-resource-library"
  "teachers-classroom-tools"
  "school-district-portal"
  "learning-platform-kids"
  "educational-games-hub"
  "k12-learning-center"
  "math-science-practice"
  "reading-language-arts"
  "homeschool-curriculum-edu"
  "tutoring-services-online"
  "student-success-portal"
  "educational-software-llc"
)

SUCCESS=0
FAILED=0

for PROJECT in "${PROJECTS[@]}"; do
  echo "Deploying to: $PROJECT.pages.dev"
  
  # Create deployment
  result=$(curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/pages/projects/$PROJECT/deployments" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"branch\": \"$BRANCH\", \"files\": {}}")
  
  if echo "$result" | grep -q '"success":true'; then
    deployment_id=$(echo "$result" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    echo "  ✓ Deployment created: $deployment_id"
    ((SUCCESS++))
  else
    echo "  ✗ Failed to create deployment"
    echo "  Response: $result"
    ((FAILED++))
  fi
  echo ""
done

echo "=========================================="
echo "Deployment Summary"
echo "=========================================="
echo "Successful: $SUCCESS"
echo "Failed: $FAILED"
echo ""

if [ $FAILED -eq 0 ]; then
  echo "All deployments started successfully!"
  echo ""
  echo "Your educational mirrors:"
  for PROJECT in "${PROJECTS[@]}"; do
    echo "  https://$PROJECT.pages.dev"
  done
fi
