import { test, expect } from '@playwright/test';
test('FHIR-only sign-in searches by POST and displays linked actual Patient and Encounter JSON',async({page})=>{
  const personId='11111111-1111-4111-8111-111111111111';
  const patient={resourceType:'Patient',id:'chs-demo-patient',name:[{text:'Synthetic Demo Patient'}],birthDate:'1990-01-02',gender:'female'};
  const encounter={resourceType:'Encounter',id:'chs-demo-encounter',status:'finished',class:{system:'http://terminology.hl7.org/CodeSystem/v3-ActCode',code:'AMB'},subject:{reference:'Patient/chs-demo-patient'}};
  await page.addInitScript(()=>sessionStorage.setItem('chs.operations.session',JSON.stringify({accessToken:'synthetic-fhir-viewer',expiresAt:Date.now()+900000})));
  await page.route('**/api/v1/operations/fhir/**',async route=>{
    expect(route.request().method()).toBe('POST');
    const body=route.request().postDataJSON();expect(body.reasonCode).toBe('FHIR_DEMONSTRATION');
    let response:unknown;
    if(route.request().url().endsWith('/access'))response={fhirOnly:true};
    else if(route.request().url().endsWith('/search')){
      expect(body.name).toBe('Synthetic');expect(body.dateOfBirth).toBe('1990-01-02');
      response={items:[{personId,generation:'1',resource:patient}],page:1,hasMore:false};
    } else {expect(body.personId).toBe(personId);response={bundle:{resourceType:'Bundle',type:'collection',entry:(body.resourceType?[encounter]:[patient,encounter]).map(resource=>({resource}))},generation:'1',page:1,hasMore:false};}
    await route.fulfill({json:response});
  });
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'FHIR Resources',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Accounts',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Patient Viewer',exact:true})).toHaveCount(0);
  await page.getByLabel('Patient name',{exact:true}).fill('Synthetic');
  await page.getByLabel('Date of birth',{exact:true}).fill('1990-01-02');
  await page.getByRole('button',{name:'Search FHIR patients'}).click();
  await page.getByRole('button',{name:/Synthetic Demo Patient.*DOB/}).click();
  await expect(page.locator('.fhir-json').first()).toContainText('"resourceType": "Patient"');
  await page.getByRole('navigation',{name:'Mapped FHIR resources'}).getByRole('button',{name:/Encounter/}).click();
  await expect(page.locator('.fhir-json').first()).toContainText('"subject"');
  await page.getByRole('button',{name:'Patient/chs-demo-patient',exact:true}).click();
  await expect(page.locator('.fhir-json').first()).toContainText('"birthDate": "1990-01-02"');
  await page.getByLabel('Resource type',{exact:true}).selectOption('Encounter');
  await expect(page.locator('.fhir-json').first()).toContainText('"resourceType": "Encounter"');
  await page.getByText('POST request demonstration',{exact:true}).click();
  await expect(page.locator('.fhir-json').last()).toContainText('"resourceType": "Encounter"');
  await page.screenshot({path:'test-results/fhir-viewer-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
  await page.screenshot({path:'test-results/fhir-viewer-mobile.png',fullPage:true});
});
