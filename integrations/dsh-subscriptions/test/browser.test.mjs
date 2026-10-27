import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright-core';

const preview=process.env.DSH_BROWSER_PREVIEW;
test('native client loads and saves independent models in ordinary conversation settings', {skip:!preview,timeout:90000},async()=>{
  const url=await readFile(preview,'utf8');
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const errors=[];
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(url);await page.getByRole('button',{name:'账号菜单',exact:true}).waitFor();
    const notice=page.getByRole('button',{name:'继续',exact:true});
    try{await notice.waitFor({timeout:1200});await notice.click();}catch{}
    await page.getByRole('button',{name:'账号菜单',exact:true}).click();await page.getByRole('menuitem',{name:/设置/}).click();
    await page.getByRole('button',{name:'订阅连接与模型设置',exact:true}).click();
    await page.getByLabel('默认主模型',{exact:true}).waitFor();
    const dialog=page.getByRole('dialog');
    assert.equal(await dialog.getByRole('button',{name:'登录账号',exact:true}).count(),3);
    await page.getByLabel('默认主模型',{exact:true}).selectOption(JSON.stringify(['fixture-deepseek','model']));
    await page.getByLabel('默认子模型',{exact:true}).selectOption(JSON.stringify(['fixture-api','model']));
    await page.getByLabel('允许不同子代理另选模型').check();
    await page.getByRole('button',{name:'选择全部渠道',exact:true}).click();
    await page.getByRole('button',{name:'保存设置',exact:true}).click();
    await page.getByText('已保存。请新建对话使用。',{exact:true}).waitFor({timeout:30000});
    assert.equal(await page.getByLabel('默认子模型',{exact:true}).inputValue(),JSON.stringify(['fixture-api','model']));
    const scratch=resolve(preview,'..');
    await page.screenshot({path:resolve(scratch,'settings-verified.png'),fullPage:true});
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'新建会话',exact:true}).first().click();
    assert.equal(await page.getByRole('button',{name:/选择模型，当前 Scripted fixture-deepseek/}).count(),1);
    assert.deepEqual(errors,[]);
    await writeFile(resolve(scratch,'browser-result.json'),JSON.stringify({clientLoaded:true,threeLoginCards:true,nativeModelSettingsSaved:true,ordinaryConversation:true,pageErrors:errors,realModelCalls:0},null,2));
  }finally{await browser.close();}
});
