/* Bookmarklets library. A bookmarklet is a tiny button that lives on your
   bookmarks bar. Open any page, click the button, and it runs. No extensions,
   no installs. This tab shows the catalog: name, one line on what it does,
   and the code. Copy a code, make a new bookmark, paste it as the URL. */

(function () {
  "use strict";

  function cloaked(url) {
    return "javascript:var w=window.open();var u='" + url +
      "';var f=w.document.createElement('iframe');f.style='position:fixed;width:100vw;height:100vh;top:0;left:0;border:none;background:#fff';f.src=u;w.document.body.appendChild(f);";
  }

  var DATA = [
    {
      label: "Cloak and hide",
      hint: "make a tab or page look like something else",
      items: [
        {
          name: "Tab cloak",
          blurb: "Rename this tab and swap its icon.",
          code: `javascript:(function(){document.title=prompt("New tab title:")||document.title;var i=document.querySelector('link[rel="icon"]');var c=prompt("Icon: [1] Google [2] Drive [3] Custom");if(c=="1")i.setAttribute("href","https://www.google.com/favicon.ico");if(c=="2")i.setAttribute("href","https://ssl.gstatic.com/images/branding/product/2x/hh_drive_96dp.png");if(c=="3")i.setAttribute("href",prompt("Icon URL:"));})();`
        },
        {
          name: "Drive disguise",
          blurb: "Looks like Google Drive, stays that way.",
          code: `javascript:(function(){function g(){var l=document.querySelector("link[rel*='icon']")||document.createElement('link');l.rel='shortcut icon';l.href='https://ssl.gstatic.com/docs/doclist/images/infinite_arrow_favicon_5.ico';document.title='My Drive - Google Drive';document.head.appendChild(l);}g();setInterval(g,1000);})();`
        },
        {
          name: "Embed site",
          blurb: "Open any site inside a fresh blank page.",
          code: `javascript:(function(){var url=prompt("Website URL:");if(!url)return;if(!/^https?:\\/\\//i.test(url))url="https://"+url;var w=window.open();var f=w.document.createElement('iframe');f.style='position:fixed;width:100vw;height:100vh;top:0;left:0;border:none;background:#fff';f.src=url;w.document.body.appendChild(f);})();`
        },
        {
          name: "Blur page",
          blurb: "Smudge the whole page in one click.",
          code: `javascript:(function(){var s=document.createElement('style');s.id='bk-blur';s.textContent='html{filter:blur(14px) !important}';document.head.appendChild(s);})();`
        },
        {
          name: "Unblur page",
          blurb: "Undo the blur and read again.",
          code: `javascript:(function(){var s=document.getElementById('bk-blur');if(s)s.remove();})();`
        }
      ]
    },
    {
      label: "Cloaked proxies",
      hint: "open a proxy in a blank window nobody can trace",
      items: [
        {
          name: "This site's proxy",
          blurb: "Launch this site's own proxy, cloaked.",
          code: "javascript:var w=window.open();var u=location.origin+'/uv/';var f=w.document.createElement('iframe');f.style='position:fixed;width:100vw;height:100vh;top:0;left:0;border:none;background:#fff';f.src=u;w.document.body.appendChild(f);"
        },
        {
          name: "Nebula",
          blurb: "Cloaked launch of the Nebula proxy.",
          code: cloaked("https://nebula.galaxybender.repl.co/")
        },
        {
          name: "Ultraviolet",
          blurb: "Cloaked launch of the Ultraviolet proxy.",
          code: cloaked("https://ultraviolet-node.galaxybender.repl.co/")
        },
        {
          name: "Incognito",
          blurb: "Cloaked launch of the Incognito proxy.",
          code: cloaked("https://incognito.galaxybender.repl.co/")
        },
        {
          name: "Holy Unblocker",
          blurb: "Cloaked launch of the Holy Unblocker proxy.",
          code: cloaked("https://website-aio.galaxybender.repl.co/")
        },
        {
          name: "General Mathematics",
          blurb: "Cloaked launch of General Mathematics.",
          code: cloaked("https://general-mathematics-beta.galaxybender.repl.co/")
        }
      ]
    },
    {
      label: "Edit and inspect",
      hint: "tweak any page on the fly",
      items: [
        {
          name: "Edit page",
          blurb: "Turn any page into a text box.",
          code: `javascript:(function(){document.body.contentEditable='true';document.designMode='on';void 0;})();`
        },
        {
          name: "Stop editing",
          blurb: "Turn it back to a normal page.",
          code: `javascript:(function(){document.body.contentEditable='false';document.designMode='off';void 0;})();`
        },
        {
          name: "Show passwords",
          blurb: "Reveal the dots in password fields.",
          code: `javascript:(function(){document.querySelectorAll('input[type="password"]').forEach(function(i){i.type='text';});})();`
        },
        {
          name: "Delete element",
          blurb: "Hover anything, click to remove it.",
          code: `javascript:(function(){var cur=null;function over(e){if(cur)cur.style.outline='';cur=e.target;cur.style.outline='2px dashed #e33';}function kill(e){e.preventDefault();e.stopPropagation();if(cur)cur.remove();document.removeEventListener('mouseover',over,true);document.removeEventListener('click',kill,true);}document.addEventListener('mouseover',over,true);document.addEventListener('click',kill,true);})();`
        }
      ]
    },
    {
      label: "Handy tools",
      hint: "small things that save a step",
      items: [
        {
          name: "Calculator",
          blurb: "Quick math, no history trail.",
          code: `javascript:(function(){var z='';function c(){var o=prompt('Expression:',z);if(o==null)return false;if(o==='')return false;try{z=String(eval(o));}catch(e){z='';}alert(z);return true;}while(c());})();`
        },
        {
          name: "History flood",
          blurb: "Pile up this page in your history.",
          code: `javascript:(function(){var num=prompt("How many history entries?");if(!num)return;var x=location.href;for(var i=1;i<=num;i++){history.pushState(0,0,i==num?x:String(i));}alert("Done. This page now shows "+num+" time"+(num==1?".":"s."));})();`
        },
        {
          name: "Autoclicker",
          blurb: "Pick a spot, it clicks on its own.",
          code: `javascript:(function(){var DELAY=1;var st=document.createElement("style");st.textContent="*{cursor:crosshair !important}";document.body.appendChild(st);function ac(el){if(el.classList.contains("bk-ac")){el.click();setTimeout(function(){ac(el);},DELAY);}}document.body.addEventListener("click",function(e){if(!e.isTrusted)return;e.preventDefault();st.remove();var el=e.target;el.classList.add("bk-ac");ac(el);},{once:true});})();`
        },
        {
          name: "Word count",
          blurb: "How many words are on this page.",
          code: `javascript:(function(){var t=(document.body.innerText||'').trim();var n=t?t.split(/\\s+/).length:0;alert('Words on this page: '+n);})();`
        }
      ]
    },
    {
      label: "Just for fun",
      hint: "yes, all of these run in the browser",
      items: [
        {
          name: "Snake",
          blurb: "The classic, right on the page.",
          code: `javascript:Q=64;m=b=Q*Q;a=[P=l=u=d=p=S=w=0];u=89;f=(h=j=t=(b+Q)/2)-1;(B=(D=document).body).appendChild(x=D.createElement("p"));(X=x.style).position="fixed";X.left=X.top=0;X.background="#FFF";x.innerHTML="<p></p><canvas>";v=(s=x.childNodes)[0];(s=s[1]).width=s.height=5*Q;c=s.getContext("2d");onkeydown=onblur=F=function(e,g){g?a[f]?(w+=m,f=Math.random(l+=8)*(R=Q-2)*R|(u=0),F(f+=Q+1+2*(f/R|0),g)):F(f):0>e?(l?--l:(y=t,t=a[t]-2,F(y)),S+=(w*=0.8)/4,m=999/(u+++10),a[h+=[-1,-Q,1,Q][d=p]]?B.removeChild(x,alert("Game Over")):(F(h),F(e,j=h),v.innerHTML=P?(setTimeout(F,50,e,0),S|0):"Press P")):-e?(y=(a[e]=e<Q|e>=Q*Q-Q|!(e%Q)|e%Q==Q-1|2*(e==h))+(e==f),e==h&&(a[j]=2+h),c.fillStyle="hsl("+99*!a[e]+","+2*m+"%,"+50*y+"%)",c.fillRect(e%Q*5,5*(e/Q|0),5,5)):isNaN(y=e.keyCode-37)|43==y?(P=y&&!P)&&F(-1):p=!P|y&-4|!(y^2^d)?p:y;return!1};for(;--b;F(b));void F(-1);`
        },
        {
          name: "StopAtNothing",
          blurb: "Stop the timer right on zero.",
          code: `javascript:(function(){var b=document.createElement("iframe");b.src="https://www.stopatnothinggame.com";b.style="position:fixed;z-index:999999;width:440px;height:440px;top:20px;right:20px;border:5px solid #8834af;background:#fff";document.body.appendChild(b);})();`
        },
        {
          name: "Disorient",
          blurb: "Spin every element a random touch.",
          code: `javascript:(function(){['',"-ms-","-webkit-","-o-","-moz-"].forEach(function(p){Array.prototype.slice.call(document.querySelectorAll('div,p,span,img,a,body')).forEach(function(el){el.style[p+'transform']='rotate('+(Math.floor(Math.random()*3)-1)+'deg)';});});})();`
        },
        {
          name: "Rainbow page",
          blurb: "Give everything a random color.",
          code: `javascript:(function(){document.querySelectorAll('*').forEach(function(el){el.style.backgroundColor='#'+Math.floor(Math.random()*16777215).toString(16);});})();`
        },
        {
          name: "Spazzy images",
          blurb: "Every image on the page starts flying.",
          code: `javascript:R=0;x1=.1;y1=.05;x2=.25;y2=.24;x3=1.6;y3=.24;x4=300;y4=200;x5=300;y5=200;DI=document.getElementsByTagName("img");DIL=DI.length;function A(){for(i=0;i<DIL;i++){DIS=DI[i].style;DIS.position='absolute';DIS.left=(Math.sin(R*x1+i*x2+x3)*x4+x5)+"px";DIS.top=(Math.cos(R*y1+i*y2+y3)*y4+y5)+"px";}R++;}setInterval(A,50);void 0;`
        },
        {
          name: "Panic screen",
          blurb: "A fake blue screen for walk-bys.",
          code: `javascript:(function(){var d=document.createElement('div');d.style.cssText='position:fixed;inset:0;background:#0078d7;color:#fff;font:28px/1.6 "Segoe UI",sans-serif;padding:60px;z-index:2147483647;cursor:pointer';d.innerHTML='<b>:(</b><br><br>Your PC ran into a problem and needs to restart.<br><br>Stop code: KERNEL_PANIC_BUT_NOT_REALLY<br><br>Click anywhere to keep going.';d.onclick=function(){d.remove();};document.body.appendChild(d);})();`
        }
      ]
    }
  ];

  /* ---------- rendering ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function copyText(txt, btn) {
    function done() {
      var old = btn.textContent;
      btn.textContent = "Copied";
      btn.classList.add("is-done");
      setTimeout(function () {
        btn.textContent = old;
        btn.classList.remove("is-done");
      }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(txt).then(done, function () { fallback(); });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = txt;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* no copy */ }
      ta.remove();
    }
  }

  function render() {
    var grid = document.getElementById("bk-grid");
    if (!grid) return;
    grid.innerHTML = "";

    DATA.forEach(function (group) {
      var sec = el("section", "bk-group");
      var head = el("div", "bk-group-head");
      head.appendChild(el("h2", "bk-group-title", group.label));
      head.appendChild(el("span", "bk-group-hint", group.hint));
      sec.appendChild(head);

      var cards = el("div", "bk-cards");
      group.items.forEach(function (it) {
        var card = el("article", "bk-card");
        var top = el("div", "bk-card-top");
        top.appendChild(el("h3", "bk-card-name", it.name));
        var copy = el("button", "btn bk-copy", "Copy");
        copy.type = "button";
        copy.addEventListener("click", function () { copyText(it.code, copy); });
        top.appendChild(copy);
        card.appendChild(top);

        card.appendChild(el("p", "bk-blurb", it.blurb));

        var pre = el("div", "bk-code");
        var inner = document.createElement("pre");
        inner.appendChild(document.createTextNode(it.code));
        pre.appendChild(inner);
        card.appendChild(pre);

        card.addEventListener("click", function (e) {
          if (e.target.closest("button")) return;
          /* Someone selecting the code text is not a copy intent. */
          try { if (window.getSelection && String(window.getSelection()).length > 0) return; } catch (err) {}
          copyText(it.code, copy);
        });
        cards.appendChild(card);
      });
      sec.appendChild(cards);
      grid.appendChild(sec);
    });

    var count = document.getElementById("bk-count");
    if (count) {
      var total = DATA.reduce(function (n, g) { return n + g.items.length; }, 0);
      count.textContent = total + " bookmarklets";
    }
  }

  function init() {
    var grid = document.getElementById("bk-grid");
    if (!grid) return;
    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.ChalkleBookmarklets = { render: render };
})();