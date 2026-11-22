/* 星系会意图：图数据与回答生命周期由 GraphView 管理，这里只负责立体排布和交互。 */
;(function (global) {
'use strict'
const {GraphView,utils}=global.CoReadGraphView
const initialCenters=[[-450,-175,158],[-85,-223,-105],[330,-155,140],[-636,116,-150],[-260,117,95],[150,88,-235],[525,135,100],[-408,347,-280],[9,325,105],[406,365,-260]]
const unassignedCenter=[650,-180,-250]
const orbitRadius=count=>31+Math.sqrt(count)*16

function arrangeBooks(books,previous){
  const records=new Map(previous?.records.map(r=>[r.name,{...r}])||[])
  const count=new Map(books.map(([name,nodes])=>[name,nodes.length]))
  if(!records.has(''))records.set('',{name:'',center:unassignedCenter,slot:10,radius:orbitRadius(count.get('')||0),fresh:false})
  const named=books.filter(([name])=>name)
  if(!previous)named.slice(0,initialCenters.length).forEach(([name,nodes],slot)=>{
    records.set(name,{name,center:initialCenters[slot],slot,radius:orbitRadius(nodes.length),fresh:false})
  })
  // Keep old centers and give a growing book its current footprint when looking for free space.
  for(const [name,r] of records)if(count.has(name))r.radius=orbitRadius(count.get(name))
  let slot=Math.max(...Array.from(records.values(),r=>r.slot))+1
  for(const [name,nodes] of named){
    if(records.has(name))continue
    const radius=orbitRadius(nodes.length)
    let center
    for(let ring=0;!center;ring++){
      const tries=Math.max(1,ring*16)
      for(let i=0;i<tries;i++){
        const a=2*Math.PI*(i+.19)/tries
        const p=[Math.round(ring*100*Math.cos(a)),Math.round(38+ring*85*Math.sin(a)),((slot%5)-2)*48]
        if(Array.from(records.values()).every(r=>
          Math.hypot(p[0]-r.center[0],p[1]-r.center[1])>=radius+r.radius+30)){
          center=p;break
        }
      }
    }
    records.set(name,{name,center,slot:slot++,radius,fresh:true})
  }
  return {records:[...records.values()]}
}

const markup=`
<canvas role="img" aria-label="书籍星系。拖动旋转视角，滚轮拉近，点轨道内进入星系。">
</canvas>
<header>
<div>
<h1>会意图 · 书籍星系</h1>
<p id="count">
</p>
</div>
<div id="controls">
<input id="book-search" type="search" placeholder="搜索知识点…" aria-label="搜索全图节点" autocomplete="off">
<div id="book-result">
</div>
<button id="reset" type="button">回到全览</button>
<button id="orbit-close" type="button" aria-label="关闭会意图">×</button>
</div>
</header>
<button id="new-book" hidden>新书 · 前往</button>
<aside id="gv-detail" aria-label="观点详情" hidden>
<div id="gv-detail-head">
<strong>观点详情</strong>
<button id="font-down" type="button" aria-label="缩小字号">A−</button>
<button id="font-up" type="button" aria-label="放大字号">A＋</button>
<button id="toggle-node" type="button" aria-controls="gv-detail-scroll" aria-expanded="true">折叠</button>
<button id="close-node" type="button" aria-label="关闭详情">×</button>
</div>
<div id="gv-detail-scroll">
<h2 id="gv-detail-text" aria-live="polite">
</h2>
<p id="gv-detail-meta">
</p>
<div id="gv-detail-body">
</div>
</div>
</aside>
<footer>
<span id="detail" aria-live="polite">拖动旋转 · 滚轮拉近 · 点击书名靠近</span>
<button id="orbit-hits" type="button" hidden>隐藏引用高亮</button>
</footer>
`
function mountOrbit(root,books,edges,options){
  root.innerHTML=markup
  const {markdown}=options
  let nextIndex=0
  for(const b of books)for(const n of b.nodes)n.index=nextIndex++
  const incident=Array.from({length:nextIndex},()=>[])
  for(const edge of edges){incident[edge[0]].push(edge);incident[edge[1]].push(edge)}
  const graphIndexes=new Map(books.flatMap(b=>b.nodes.filter(n=>n[4]!=null).map(n=>[n[4],n.index])))
  let answerHits=null,answerSource=null,answerEdges=[]
  function setAnswerHits({used,hits}={}){
    // An explicit empty used list means this answer used nothing. Only older data can fall back.
    const ids=Array.isArray(used)?used:Array.isArray(hits)?hits:null
    answerHits=ids?new Set(ids.map(id=>graphIndexes.get(id)).filter(Number.isInteger)):null
    answerSource=Array.isArray(used)?'used':ids?'legacy':null
    answerEdges=answerHits?edges.filter(([a,b])=>answerHits.has(a)&&answerHits.has(b)):[]
    footerQuery=undefined
    if(chosen)updateNodeMeta(chosenBook,chosen)
  }
  function syncHighlight(hl){
    const source=hl&&!hl.hidden?hl.source:null
    const ids=source&&hl.ids
    setAnswerHits(source==='stack'?{hits:ids}:{used:ids})
    if(source==='picked'){answerSource='picked';footerQuery=undefined;if(chosen)updateNodeMeta(chosenBook,chosen)}
    const button=root.querySelector('#orbit-hits')
    button.hidden=!hl
    button.textContent=hl?.hidden?'显示引用高亮':'隐藏引用高亮'
    updateFooter()
  }
  const isAnswerHit=n=>Boolean(n&&answerHits?.has(n.index))
  function nodeDegrees(index,subset=null){
    let incoming=0,outgoing=0
    for(const [from,to] of incident[index]){
      if(subset&&(!subset.has(from)||!subset.has(to)))continue
      if(from===index)outgoing++
      if(to===index)incoming++
    }
    return '入 '+incoming+' · 出 '+outgoing
  }
  const fullCount=books.reduce((a,b)=>a+b.nodes.length,0)
  root.querySelector('#count').textContent=books.filter(b=>b.name).length+' 本书 / '+fullCount+' 个观点'+(options.example?' · 演示数据':'')
  const canvas=root.querySelector('canvas'),ctx=canvas.getContext('2d')
  const colors=['#88c9ff','#92e3cf','#d5b1fb','#f7c68f','#aab7ff','#8addf1','#efb4cf','#bbdf99','#a9ceff','#ead2b1','#95a5be']
  const tau=2*Math.PI, reduced=matchMedia('(prefers-reduced-motion: reduce)')
  const short=s=>Array.from(s).slice(0,12).join('')+(Array.from(s).length>12?'…':'')
  const worlds=books.map(b=>{
    const i=b.slot
    const radius=31+Math.sqrt(b.nodes.length)*16, tilt=.37+(i%5)*.22, turn=i*.57-.25
    const bands=Array.from({length:5},()=>[])
    for(const n of b.nodes){const d=n[0];bands[d>=7?0:d>=4?1:d>=2?2:d?3:4].push(n)}
    return {...b,radius,tilt,turn,ink:colors[i%colors.length],i,
      rings:bands.map((ns,j)=>({r:radius*(.22+j*.19), speed:(.105-j*.013+(i%11)*.001)*.45,
        nodes:ns.map((row,k)=>{
          const [degree,text,aliases,discussions]=row
          return {index:row.index,id:row[4],degree,text,aliases,discussions,a:tau*(k+.16+j*.22)/ns.length}
        })}))}
  })
  const overviewDistance=Math.max(1690,...worlds.map(b=>Math.hypot(b.center[0],b.center[1]-38,b.center[2])+b.radius+520))
  const saved=options.snapshot
  let w=0,h=0,unit=1,yaw=saved?.yaw??.04,pitch=saved?.pitch??-.10,distance=saved?.distance??overviewDistance,target=saved?.target??[0,38,0],flight=null
  let focus=worlds.find(b=>b.name===saved?.focusName)||null
  let down=null,time=saved?.time??0,last=0,chosen=null,chosenBook=null,hit=[]
  let galaxyBounds=[],pointer=null
  let hovered=null,relationIds=new Set(),drawnRelations=0
  let searchMatches=new Set(),searchQuery=''
  const isSearchMatch=n=>Boolean(n&&searchMatches.has(n.index))
  const isRelated=n=>Boolean(n&&relationIds.has(n.index))
  function sceneOpacity(n,b,active){
    if(isSearchMatch(n)||isRelated(n)||isAnswerHit(n))return 1
    if(active)return .28
    if(searchMatches.size&&n)return .20
    if(answerHits?.size&&n)return .25
    return focus&&focus!==b?.42:1
  }
  const footerDetail=root.querySelector('#detail')
  let footerNode,footerBook,footerQuery
  function updateFooter(){
    const node=down?.moved?null:hovered
    if(footerNode===node&&footerBook===focus&&footerQuery===searchQuery)return
    footerNode=node;footerBook=focus;footerQuery=searchQuery
    footerDetail.classList.toggle('is-hovered',Boolean(node))
    const summary=searchQuery?(searchMatches.size?'搜索命中 '+searchMatches.size+' 个节点':'没有匹配的节点'):
      answerHits?.size?(answerSource==='legacy'?'旧版命中 ':answerSource==='picked'?'已选引用 ':'回答引用 ')+answerHits.size+' 个节点':''
    footerDetail.textContent=node?(summary?summary+' · ':'')+node.text:summary||(
      options.isPicking()?'单击查看详情 · 双击设为引用':
      focus?(short(focus.name)||'未归书')+' · 点击轨道外返回全览':'拖动旋转 · 滚轮拉近 · 点击轨道内进入星系')
  }
  function refreshFooter(){footerQuery=undefined}
  const clamp=(v,a,b)=>Math.min(b,Math.max(a,v))
  const {labelShape,wrapText}=utils
  const LABEL_MIN_SCALE=.5
  const labelRatio=s=>s
  const labelFont=px=>px+'px system-ui, sans-serif'

  // Use the same description tier across the scene. Perspective still affects the points.

  const descriptionScale=()=>230/distance
  const detailCard=root.querySelector('#gv-detail')
  const detailToggle=root.querySelector('#toggle-node')
  function collapseDetail(collapsed){
    detailCard.dataset.collapsed=String(collapsed)
    detailToggle.setAttribute('aria-expanded',String(!collapsed))
    detailToggle.textContent=collapsed?'展开':'折叠'
  }
  detailToggle.onclick=()=>collapseDetail(detailToggle.getAttribute('aria-expanded')==='true')
  const labelCache=new WeakMap(), shownLabels=[]
  const overlapArea=(a,b)=>Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*
    Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top))
  let detailFont=15
  for(const [id,delta] of [['font-down',-1],['font-up',1]]){
    root.querySelector('#'+id).onclick=()=>{
      detailFont=clamp(detailFont+delta,11,23)
      detailCard.style.setProperty('--detail-font',detailFont+'px')
    }
  }
  const element=(tag,text)=>{const el=document.createElement(tag);el.textContent=text;return el}
  const markupTags=new Set('P BR HR STRONG EM DEL CODE PRE H3 H4 H5 H6 BLOCKQUOTE UL OL LI TABLE THEAD TBODY TR TH TD A'.split(' '))
  function renderMarkdown(el,value,inline=false){
    const fragment=document.createElement('template')
    fragment.innerHTML=markdown(value,inline)
    function copy(node){
      if(node.nodeType===3)return document.createTextNode(node.textContent)
      if(!markupTags.has(node.tagName))return document.createTextNode(node.textContent||'')
      const safe=document.createElement(node.tagName.toLowerCase())
      if(node.tagName==='A'){
        const url=node.getAttribute('href')||''
        if(/^(https?:\/\/|mailto:)/i.test(url)){safe.href=url;safe.target='_blank';safe.rel='noopener noreferrer'}
      }
      safe.append(...Array.from(node.childNodes,copy))
      return safe
    }
    el.classList.add('md')
    el.replaceChildren(...Array.from(fragment.content.childNodes,copy))
    return el
  }
  function closeNode(){
    chosen=null;chosenBook=null;detailCard.hidden=true
  }
  root.querySelector('#close-node').onclick=closeNode
  root.addEventListener('keydown',e=>{if(e.key==='Escape'&&!detailCard.hidden){e.stopPropagation();closeNode()}})
  function updateNodeMeta(b,n){
    const current=isAnswerHit(n)?' · '+(answerSource==='legacy'?'旧版命中范围':answerSource==='picked'?'选中引用节点之间':'本轮引用节点之间')+' '+nodeDegrees(n.index,answerHits):''
    root.querySelector('#gv-detail-meta').textContent=(b.name||'未归书')+current+' · 历史 '+nodeDegrees(n.index)
  }
  function selectNode(b,n){
    chosen=n;chosenBook=b;collapseDetail(false)
    updateNodeMeta(b,n)
    renderMarkdown(root.querySelector('#gv-detail-text'),n.text,true)
    const body=root.querySelector('#gv-detail-body')
    body.replaceChildren()
    if(n.aliases&&n.discussions){
      body.append(element('h3','相关说法'))
      if(n.aliases.length){
        const list=document.createElement('ul')
        list.className='aliases'
        list.append(...n.aliases.map(t=>renderMarkdown(document.createElement('li'),t)));body.append(list)
      }else {const empty=element('p','暂无相关说法');empty.className='empty';body.append(empty)}
      body.append(element('h3','专题化讨论'))
      for(const [book,chapter,question,excerpts] of n.discussions){
        const card=document.createElement('div'), disc=document.createElement('details')
        card.className='discussion'
        disc.append(renderMarkdown(document.createElement('summary'),question||'讨论记录',true))
        card.append(disc)
        const source=[book?'《'+book+'》':'自由对话',chapter,excerpts.length?excerpts.length+' 轮讨论':''].filter(Boolean)
        const meta=element('p',source.join(' · '));meta.className='source';disc.append(meta)
        if(excerpts.length){
          const rounds=document.createElement('div'), part=document.createElement('div')
          rounds.className='rounds';part.className='round-body'
          const show=i=>{
            const [q,a]=excerpts[i]
            const content=document.createElement('div');content.className='round-content'
            for(const [label,value] of [['问',q],['答',a]])if(value){
              const p=document.createElement('div');p.className='exchange'
              p.append(element('b',label),renderMarkdown(document.createElement('div'),value));content.append(p)
            }
            part.replaceChildren(content);part.scrollTop=0
            Array.from(rounds.children).forEach((button,index)=>button.setAttribute('aria-pressed',String(index===i)))
          }
          excerpts.forEach((_,i)=>{
            const button=element('button',String(i+1));button.type='button';button.setAttribute('aria-label','第 '+(i+1)+' 轮')
            button.title=excerpts[i][0]
            button.onclick=()=>{disc.open=true;show(i)};rounds.append(button)
          })
          card.append(rounds,part)
          disc.addEventListener('toggle',()=>{part.hidden=!disc.open})
          part.hidden=true
          rounds.addEventListener('click',()=>{if(disc.open)part.hidden=false})
          show(0)
        }
        body.append(card)
      }
      if(!n.discussions.length){const empty=element('p','暂无讨论记录');empty.className='empty';body.append(empty)}
    }
    root.querySelector('#gv-detail-scroll').scrollTop=0
    detailCard.hidden=false
  }
  function drawNodeLabels(){
    shownLabels.length=0
    const scale=descriptionScale()
    if(scale<LABEL_MIN_SCALE||flight)return
    const {chars,lines}=labelShape(labelRatio(scale))
    const font=scale>=1.2?11:10, lineH=font+2
    ctx.font=labelFont(font);ctx.textAlign='center';ctx.textBaseline='top'
    for(const {p,n,b,r} of hit){
      if(!n)continue
      if(!isSearchMatch(n)&&!isRelated(n)&&!isAnswerHit(n)&&(searchMatches.size||focus&&focus!==b))continue
      let m=labelCache.get(n)
      if(!m||m.chars!==chars||m.font!==font){
        const text=wrapText(n.text,chars,lines)
        m={chars,font,text,width:Math.ceil(Math.max(...text.map(t=>ctx.measureText(t).width)))+4}
        labelCache.set(n,m)
      }
      const bw=m.width,bh=m.text.length*lineH+2
      const x=p.x-bw/2,y=p.y+r-1
      const box={left:x,right:x+bw,top:y,bottom:y+bh}
      if(box.right<0||x>w||box.bottom<0||y>h)continue
      shownLabels.push({p,box,b,n,text:m.text,bw,bh,coverage:0})
    }
    shownLabels.sort((a,b)=>a.p.z-b.p.z)
    for(const [i,label] of shownLabels.entries()){
      const {p,box,n,text,bw,bh}=label
      // Fade continuously as the foreground covers more of this label.
      let covered=0
      for(let j=i+1;j<shownLabels.length;j++){
        const front=shownLabels[j]
        const depthWeight=clamp((front.p.z-p.z)/12,0,1)
        covered+=overlapArea(box,front.box)*depthWeight
      }
      label.coverage=clamp(covered/(bw*bh),0,1)
      const dim=1-.94*Math.pow(label.coverage,.42)
      ctx.globalAlpha=((chosen||hovered)&&!isRelated(n)&&!isSearchMatch(n)&&!isAnswerHit(n)?.48:1)*dim
      ctx.fillStyle='#0d1728e8';ctx.fillRect(box.left,box.top,bw,bh)
      ctx.fillStyle='#dceaff'
      text.forEach((t,j)=>ctx.fillText(t,p.x,box.top+1+j*lineH))
    }
    hit.push(...shownLabels)
  }
  const footprint=(b,r,a)=>{
    const x=r*Math.cos(a), y=r*Math.sin(a)*Math.cos(b.tilt), z=r*Math.sin(a)*Math.sin(b.tilt)
    const c=Math.cos(b.turn),s=Math.sin(b.turn)
    return [b.center[0]+x*c-y*s,b.center[1]+x*s+y*c,b.center[2]+z]
  }
  function eye([x,y,z]){
    x-=target[0];y-=target[1];z-=target[2]
    const c=Math.cos(yaw),s=Math.sin(yaw),cp=Math.cos(pitch),sp=Math.sin(pitch)
    const u=x*c-z*s,d=x*s+z*c
    return [u,y*cp-d*sp,y*sp+d*cp]
  }
  function projectEye([x,y,z]){
    const d=distance-z
    if(d<48)return null
    const k=unit/d
    return {x:w/2+x*k,y:h*.48+y*k,z,k}
  }
  const project=p=>projectEye(eye(p))
  function galaxyHull(b){
    const points=Array.from({length:48},(_,i)=>eye(footprint(b,b.rings.at(-1).r,i*tau/48)))
    const z=distance-49, clipped=[]
    for(const [i,p] of points.entries()){
      const q=points[(i+points.length-1)%points.length]
      if((p[2]<=z)!==(q[2]<=z)){
        const t=(z-q[2])/(p[2]-q[2])
        clipped.push([q[0]+(p[0]-q[0])*t,q[1]+(p[1]-q[1])*t,z])
      }
      if(p[2]<=z)clipped.push(p)
    }
    return clipped.map(projectEye)
  }
  function view(e){
    const box=canvas.getBoundingClientRect(),dpr=devicePixelRatio||1
    if(!box.width||!box.height)return false
    if(w!==box.width||h!==box.height||e){
      w=box.width;h=box.height;unit=Math.min(w/2.25,h/1.48)*2.65
      canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);ctx.setTransform(dpr,0,0,dpr,0,0)
    }
    return true
  }
  const stars=Array.from({length:155},(_,i)=>[(Math.sin(i*127.1)*43758.54%1+1)%1,(Math.sin(i*311.7)*9137.38%1+1)%1,i%7])
  const nodeRadius=(n,p)=>clamp((2.8+Math.sqrt(n.degree)*.68)*p.k,1.1,8)
  function drawRelations(active,links,positions){
    drawnRelations=0
    for(const [from,to,kind] of links){
      const a=positions.get(from),b=positions.get(to)
      if(!a||!b)continue
      const dx=b.p.x-a.p.x,dy=b.p.y-a.p.y,length=Math.hypot(dx,dy)
      const ra=nodeRadius(a.n,a.p)+2,rb=nodeRadius(b.n,b.p)+2
      if(length<ra+rb+5)continue
      const ux=dx/length,uy=dy/length,x=b.p.x-ux*rb,y=b.p.y-uy*rb
      ctx.globalAlpha=answerHits?(kind==='user'?.82:.48):.85
      ctx.strokeStyle=ctx.fillStyle=answerHits?'#86efd9':from===active?.index?'#ffd694':'#88c9ff'
      if(answerHits&&kind!=='user')ctx.setLineDash([4,4])
      ctx.lineWidth=1.35;ctx.beginPath();ctx.moveTo(a.p.x+ux*ra,a.p.y+uy*ra);ctx.lineTo(x,y);ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath();ctx.moveTo(x,y)
      ctx.lineTo(x-ux*7-uy*3,y-uy*7+ux*3);ctx.lineTo(x-ux*7+uy*3,y-uy*7-ux*3);ctx.closePath();ctx.fill()
      drawnRelations++
    }
  }
  function draw(){
    updateFooter()
    const bg=ctx.createRadialGradient(w*.46,h*.48,0,w*.46,h*.48,Math.max(w,h)*.68)
    bg.addColorStop(0,'#152442');bg.addColorStop(.56,'#10192e');bg.addColorStop(1,'#080c17')
    ctx.fillStyle=bg;ctx.fillRect(0,0,w,h)
    ctx.fillStyle='#afcaee'
    for(const [x,y,s] of stars){ctx.globalAlpha=.10+s*.044;ctx.fillRect(((x*w+yaw*(s+2)*13)%w+w)%w,((y*h+pitch*19)%h+h)%h,s===6?1.6:1,s===6?1.6:1)}
    ctx.globalAlpha=1
    const layers=[],positions=new Map()
    galaxyBounds=[]
    const active=down?.moved?chosen:(hovered||chosen)
    const links=answerHits?answerEdges:active?incident[active.index]:[]
    relationIds=active?new Set([active.index,...(answerHits?[]:links.flatMap(([a,b])=>[a,b]))]):new Set()
    for(const b of worlds){
      const sun=project(b.center)
      if(b.name){
        const hull=galaxyHull(b)
        if(hull.length>=3)galaxyBounds.push({b,hull,z:sun?.z??eye(b.center)[2]})
      }
      for(const ring of b.rings){
        if(b.name)for(let j=0;j<64;j++){
          const a=project(footprint(b,ring.r,j*tau/64)),c=project(footprint(b,ring.r,(j+1)*tau/64))
          if(a&&c)layers.push({type:0,a,c,z:(a.z+c.z)/2,b})
        }
      }
      if(sun)layers.push({type:1,p:sun,z:sun.z,b})
      for(const ring of b.rings)for(const n of ring.nodes){
        const p=project(footprint(b,ring.r,n.a+time*ring.speed))
        if(p&&(relationIds.has(n.index)||isAnswerHit(n)))positions.set(n.index,{n,p})
        if(p&&p.x>-40&&p.x<w+40&&p.y>-40&&p.y<h+40)layers.push({type:2,p,z:p.z,b,n})
      }
    }
    layers.sort((a,b)=>a.z-b.z)
    hit=[]
    drawRelations(active,links,positions)
    for(const layer of layers){
      const {type,b,p,n}=layer
      const matched=isSearchMatch(n)
      const alpha=sceneOpacity(n,b,active)
      if(!type){
        const {a,c}=layer
        ctx.globalAlpha=alpha*clamp(.34+(layer.z-eye(b.center)[2])*.002,.16,.58)
        ctx.strokeStyle=b.ink;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(c.x,c.y);ctx.stroke()
        continue
      }
      ctx.globalAlpha=alpha
      if(type===1){
        const r=clamp((b.name?9:7)*p.k,b.name?4.5:3.5,b.name?18:14)
        const glow=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*4.5)
        glow.addColorStop(0,b.name?'#ffe3a2b5':'#a6bde073');glow.addColorStop(1,'#fff0')
        ctx.fillStyle=glow;ctx.fillRect(p.x-r*4.5,p.y-r*4.5,r*9,r*9)
        ctx.beginPath();ctx.arc(p.x,p.y,b.name?r:r*.55,0,tau);ctx.fillStyle=b.name?'#fff1ca':b.ink;ctx.fill()
        hit.push({p,r:r+7,b})
      }else{
        const r=nodeRadius(n,p)
        ctx.fillStyle=b.ink;ctx.beginPath();ctx.arc(p.x,p.y,r,0,tau);ctx.fill()
        if(matched&&active!==n){ctx.beginPath();ctx.arc(p.x,p.y,r+3,0,tau);ctx.strokeStyle='#ffd694';ctx.lineWidth=1.3;ctx.stroke()}
        if(isAnswerHit(n)){ctx.beginPath();ctx.arc(p.x,p.y,r+(matched?6:3),0,tau);ctx.strokeStyle='#86efd9';ctx.lineWidth=1.6;ctx.stroke()}
        if(active===n){ctx.beginPath();ctx.arc(p.x,p.y,r+5,0,tau);ctx.strokeStyle='#fff4cf';ctx.lineWidth=1.7;ctx.stroke()}
        hit.push({p,r:r+4,b,n})
      }
    }
    const labels=[]
    for(const b of [...worlds].sort((a,b)=>a===focus?-1:b===focus?1:0)){
      const p=project(b.center);if(!p)continue
      const name=(short(b.name)||'未归书')+(showNew&&b===newBook?' · 新':'')
      ctx.font='500 13px system-ui, sans-serif'
      const len=ctx.measureText(name).width+18,x=p.x,y=p.y+clamp(b.radius*p.k*.48,18,105)+15
      const box={left:x-len/2,right:x+len/2,top:y-9,bottom:y+9}
      if(x<0||x>w||y<60||y>h-36||labels.some(q=>box.left<q.right&&q.left<box.right&&box.top<q.bottom&&q.top<box.bottom))continue
      labels.push(box)
      ctx.globalAlpha=focus&&focus!==b?.68:1
      ctx.fillStyle='#0b1324dc';ctx.beginPath();ctx.roundRect(box.left,box.top,len,18,5);ctx.fill()
      ctx.fillStyle=b.ink;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(name,x,y)
      hit.push({p:{x,y},box,b})
    }
    drawNodeLabels()
      ctx.globalAlpha=1
  }
  let frame=0
  function tick(now){
    frame=0
    if(!options.isOpen()||!view()){last=0;return}
    if(last&&!reduced.matches)time+=Math.min(now-last,50)/1000
    last=now
    if(flight){
      const u=clamp((now-flight.start)/600,0,1),s=u*u*(3-2*u)
      target=flight.from.map((n,i)=>n+(flight.to[i]-n)*s)
      distance=flight.d+(flight.end-flight.d)*s
      if(u===1)flight=null
    }
    draw()
    if(pointer&&!down&&!flight)updateHover()
    wake()
  }
  function wake(){if(!frame&&options.isOpen())frame=requestAnimationFrame(tick)}
  function fly(b){
    focus=b;hovered=null;closeNode()
    const to=b?b.center:[0,38,0],end=b?Math.max(460,b.radius*4.7):overviewDistance
    if(reduced.matches){target=[...to];distance=end;flight=null}
    else flight={start:performance.now(),from:[...target],to,d:distance,end}
  }
  const nodeSearch=root.querySelector('#book-search'), searchResults=root.querySelector('#book-result')
  const searchable=worlds.flatMap(b=>b.rings.flatMap(r=>r.nodes.map(n=>({
    b,n,text:[n.text,...(n.aliases||[]),...(n.discussions||[]).map(d=>d[2])].join(' ').toLowerCase()
  }))))
  const newBookButton=root.querySelector('#new-book')
  const newBooks=worlds.filter(b=>b.fresh)
  const seenBooks=new Set()
  try{for(const name of JSON.parse(localStorage.getItem('coread-orbit-seen-books')||'[]'))seenBooks.add(name)}catch{}
  const newBook=newBooks.find(b=>!seenBooks.has(b.name))
  let showNew=Boolean(newBook)
  function visitBook(b){
    fly(b)
    searchResults.replaceChildren()
    if(b===newBook){
      showNew=false;newBookButton.hidden=true
      seenBooks.add(b.name)
      try{localStorage.setItem('coread-orbit-seen-books',JSON.stringify([...seenBooks]))}catch{}
    }
  }
  if(newBook){
    newBookButton.hidden=false
    newBookButton.textContent='新书 · 前往 '+short(newBook.name)
    newBookButton.onclick=()=>visitBook(newBook)
  }
  const noticeTimer=newBook?setTimeout(()=>{showNew=false;newBookButton.hidden=true},18000):0
  function searchNodes(){
    searchQuery=nodeSearch.value.trim().toLowerCase()
    const matches=searchQuery?searchable.filter(item=>item.text.includes(searchQuery)):[]
    searchMatches=new Set(matches.map(({n})=>n.index))
    searchResults.replaceChildren()
    if(!searchQuery)return
    const status=element('div',matches.length?'命中 '+matches.length+' 个节点':'没有匹配的节点')
    status.className='search-status';status.setAttribute('role','status')
    searchResults.append(status,...matches.map(({b,n})=>{
      const result=element('button',n.text);result.type='button'
      result.append(element('small',short(b.name)||'未归书'))
      result.onclick=()=>{visitBook(b);selectNode(b,n)}
      return result
    }))
  }
  nodeSearch.addEventListener('input',searchNodes)
  nodeSearch.addEventListener('focus',searchNodes)
  nodeSearch.addEventListener('keydown',e=>{
    if(e.isComposing)return
    if(e.key==='Enter'){e.preventDefault();searchResults.querySelector('button')?.click()}
    if(e.key==='Escape'){e.stopPropagation();nodeSearch.value='';searchNodes()}
  })
  root.addEventListener('pointerdown',e=>{if(!e.target.closest('#controls'))searchResults.replaceChildren()})

  function pick(x,y){
    const contains=box=>x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom
    const dots=hit.filter(item=>item.n&&!item.box)
    const gap=item=>Math.hypot(x-item.p.x,y-item.p.y)
    const closest=list=>list.sort((a,b)=>gap(a)-gap(b)||b.p.z-a.p.z)[0]
    return closest(dots.filter(item=>gap(item)<=item.r-4))
      || [...hit].reverse().find(item=>item.box&&contains(item.box))
      || closest(dots.filter(item=>gap(item)<=item.r+3))
      || [...hit].reverse().find(item=>!item.n&&!item.box&&gap(item)<=item.r)
  }
  function galaxyAt(x,y,only){
    for(const {b,hull} of (only?galaxyBounds.filter(g=>g.b===only):[...galaxyBounds].sort((a,b)=>b.z-a.z))){
      let inside=false
      for(let i=0,j=hull.length-1;i<hull.length;j=i++){
        const a=hull[j],c=hull[i],dx=c.x-a.x,dy=c.y-a.y
        const u=clamp(((x-a.x)*dx+(y-a.y)*dy)/(dx*dx+dy*dy||1),0,1)
        if(Math.hypot(x-a.x-u*dx,y-a.y-u*dy)<=9)return b
        if((a.y>y)!==(c.y>y)&&x<(c.x-a.x)*(y-a.y)/(c.y-a.y)+a.x)inside=!inside
      }
      if(inside)return b
    }
    return null
  }
  function updateHover(){
    const {x,y}=pointer
    const item=pick(x,y)
    hovered=item?.n||null
    canvas.style.cursor=(item||galaxyAt(x,y,focus))?'pointer':'grab'
  }
  canvas.onpointerdown=e=>{
    if(!e.isPrimary||e.button!==0)return
    if(canvas.hasPointerCapture(e.pointerId)===false&&e.isTrusted)canvas.setPointerCapture(e.pointerId)
    const box=canvas.getBoundingClientRect()
    const x=e.clientX-box.left,y=e.clientY-box.top
    down={x:e.clientX,y:e.clientY,moved:false,item:pick(x,y),galaxy:galaxyAt(x,y,focus)}
  }
  canvas.onpointermove=e=>{
    if(!down){
      if(e.pointerType==='mouse'||e.pointerType==='pen'){
        const box=canvas.getBoundingClientRect()
        pointer={x:e.clientX-box.left,y:e.clientY-box.top}
        updateHover()
      }
      return
    }
    const dx=e.clientX-down.x,dy=e.clientY-down.y
    if(!down.moved&&Math.hypot(dx,dy)<3)return
    hovered=null;pointer=null
    flight=null;yaw+=dx*.006;pitch=clamp(pitch+dy*.006,-1.36,1.36)
    down={x:e.clientX,y:e.clientY,moved:true}
  }
  canvas.onpointerup=e=>{
    if(!e.isPrimary)return
    if(down&&!down.moved){
      const {item,galaxy}=down
      if(item?.n&&(!focus||item.b===focus||galaxy))selectNode(item.b,item.n)
      else if(focus){
        if(!galaxy&&item?.b!==focus)fly(null)
      }else if(item||galaxy)visitBook(item?.b||galaxy)
    }
    down=null
  }
  canvas.onpointercancel=()=>{down=null;hovered=null;pointer=null}
  canvas.onpointerleave=()=>{hovered=null;pointer=null;canvas.style.cursor='grab'}
  canvas.ondblclick=e=>{
    if(!options.isPicking())return
    const r=canvas.getBoundingClientRect()
    const item=pick(e.clientX-r.left,e.clientY-r.top)
    if(item?.n)options.onPick(item.n.index)
  }
  canvas.addEventListener('wheel',e=>{e.preventDefault();hovered=null;pointer=null;flight=null;distance=clamp(distance*Math.exp(e.deltaY*.0013),145,Math.max(3200,overviewDistance))},{passive:false})
  root.querySelector('#reset').onclick=()=>{yaw=.04;pitch=-.10;fly(null)}
  root.querySelector('#orbit-close').onclick=options.close
  root.querySelector('#orbit-hits').onclick=options.toggleHits
  if(saved?.query){nodeSearch.value=saved.query;searchNodes();searchResults.replaceChildren()}
  if(saved?.selected!=null){
    const item=searchable.find(({n})=>n.id===saved.selected)
    if(item){selectNode(item.b,item.n);collapseDetail(saved.collapsed)}
  }
  wake()
  return {
    wake,syncHighlight,closeNode,refreshFooter,
    snapshot(){return {yaw,pitch,distance,target,time,focusName:focus?.name,query:nodeSearch.value,selected:chosen?.id,collapsed:detailCard.dataset.collapsed==='true'}},
    clearHover(){hovered=null;pointer=null;down=null},
    fit(ids){
      const matched=searchable.filter(({n})=>ids.has(n.index))
      if(!matched.length)return
      const b=matched[0].b
      if(matched.every(item=>item.b===b)){
        if(focus!==b)fly(b)
      }else if(focus)fly(null)
    },
    reveal(index){
      const item=searchable.find(({n})=>n.index===index)
      if(!item)return false
      fly(item.b);selectNode(item.b,item.n);return true
    },
    destroy(){cancelAnimationFrame(frame);clearTimeout(noticeTimer)},
  }


}
const registryKey='coread-orbit-positions-v1'
function graphScene(graph,previous){
  const groups=new Map()
  for(const n of graph.nodes){
    const source=(n.discussions||[]).find(d=>d?.book)
    const name=utils.bookName(source?.book)
    if(!groups.has(name))groups.set(name,[])
    groups.get(name).push(n)
  }
  const entries=[...groups].sort((a,b)=>Number(!a[0])-Number(!b[0])||b[1].length-a[1].length)
  const placement=arrangeBooks(entries,previous)
  const records=new Map(placement.records.map(r=>[r.name,r]))
  const index=new Map(entries.flatMap(([,nodes])=>nodes).map((n,i)=>[n.id,i]))
  const degree=Array(index.size).fill(0)
  const edges=[]
  for(const e of graph.edges){
    const a=index.get(e.from),b=index.get(e.to)
    if(a==null||b==null||a===b)continue
    degree[a]++;degree[b]++
    edges.push([a,b,e.kind])
  }
  const books=entries.map(([name,nodes])=>({
    ...records.get(name),
    nodes:nodes.map(n=>[degree[index.get(n.id)],String(n.point||n.id),
      (n.aliases||[]).map(String),
      (n.discussions||[]).filter(Boolean).map(d=>[utils.bookName(d.book),String(d.chapter||''),String(d.question||''),
        (d.excerpts||[]).map(e=>[String(e?.q||''),String(e?.a||'')])]),n.id]),
  }))
  return {books,edges,placement,index}
}

class OrbitGraphView extends GraphView {
  _build(){
    this.container.innerHTML='<div class="coread-orbit" tabindex="-1"><div class="orbit-message" role="status"></div><div class="orbit-scene"></div><button class="orbit-fallback-close" type="button" aria-label="关闭会意图">×</button></div>'
    this.shell=this.container.firstElementChild
    this.stage=this.shell.querySelector('.orbit-scene')
    this.message=this.shell.querySelector('.orbit-message')
    this.fallbackClose=this.shell.querySelector('.orbit-fallback-close')
    this.fallbackClose.onclick=()=>this.close()
    this.shell.addEventListener('pointerdown',()=>this._cancelAutoDismiss())
    this.shell.addEventListener('keydown',e=>{
      if(e.key==='Escape'&&!e.cancelBubble){e.stopPropagation();this.close()}
    })
    this._built=true
  }
  _bind(){}
  _openOverlay(){
    super._openOverlay()
    if(!this.container.contains(document.activeElement))this.shell.focus({preventScroll:true})
  }
  setPickMode(on){super.setPickMode(on);this.orbit?.refreshFooter()}
  _resize(){this.render()}
  _ensureLoop(){this.orbit?.wake()}
  setHighlight(...args){
    super.setHighlight(...args)
    this.render()
  }
  clearHighlight(){
    this._orbitHitRevision=(this._orbitHitRevision||0)+1
    super.clearHighlight()
  }
  async applyHit(ids,reason,mode,noFit,source){
    const revision=this._orbitHitRevision=(this._orbitHitRevision||0)+1
    if(!this.graph||ids?.some(id=>!this.run?.byId.has(id))){
      await this.loadGraph(this._demo,this._free)
    }
    if(revision!==this._orbitHitRevision||!this.graph)return
    if((!mode||mode==='hit')&&ids?.length&&!ids.some(id=>this.run?.byId.has(id))){
      // 迟到的旧编号或演示图里不存在的节点，不能让上一轮继续亮着。
      super.clearHighlight()
      return
    }
    return super.applyHit(ids,reason,mode,noFit,source)
  }
  render(){
    if(this.orbit){
      const hl=this._isHitLikeHl(this.hl)?this.hl:null
      const key=hl?[hl,Boolean(this._hlHidden),hl.ids]:null
      if(key?(!this._orbitHighlight||key.some((part,i)=>part!==this._orbitHighlight[i])):this._orbitHighlight!==null){
        this._orbitHighlight=key
        this.orbit.syncHighlight(hl?{ids:[...hl.ids],source:hl.mode==='picked'?'picked':hl.source||'turn',hidden:this._hlHidden}:null)
      }
      this.orbit.wake()
    }
  }
  close(){
    super.close()
    this.orbit?.clearHover()
  }
  _fitToChain(){
    if(this.hl&&!this._hlHidden)this.orbit?.fit(new Set([...this.hl.ids].map(id=>this.orbitIndex.get(id))))
  }
  toggleHighlightHidden(){
    this._hlHidden=!this._hlHidden
    this._cancelAutoDismiss()
    this.render()
  }
  selectNode(id){return this.orbit?.reveal(this.orbitIndex.get(id))}
  closeDetail(){this.orbit?.closeNode()}
  async primeLayout(){
    // 无需计算平面推拉。首次打开时用固定轨道即时生成场景。
  }
  async _doLoad(demo,free,request){
    const query=demo?'?demo=1':free?'?free=1':''
    if(!this._built)this._build()
    const token=this._orbitLoad=Symbol()
    const current=()=>this._orbitLoad===token&&(!request||this._loadRequest===request)
    if(!this.orbit)this.showMessage('正在加载会意图…')
    try{
      const g=await this._fetchGraph(query)
      if(!current())return null
      const nodes=Array.isArray(g.nodes)?g.nodes:[], edges=Array.isArray(g.edges)?g.edges.filter(e=>e?.from&&e?.to):[]
      const key=JSON.stringify([query,g.source,nodes,edges])
      if(key!==this._orbitKey){
        this.graph={...g,nodes,edges}
        this._demo=Boolean(demo);this._free=Boolean(free)
        const ids=new Set(nodes.map(n=>n.id))
        this.run={nodes,edges:edges.filter(e=>ids.has(e.from)&&ids.has(e.to)),byId:new Map(nodes.map(n=>[n.id,n]))}
        let previous=null
        if(!demo)try{previous=JSON.parse(localStorage.getItem(registryKey)||'null')}catch{}
        if(!Array.isArray(previous?.records))previous=null
        else previous.records=previous.records.filter(r=>typeof r?.name==='string'&&Number.isInteger(r.slot)
          &&Number.isFinite(r.radius)&&Array.isArray(r.center)&&r.center.length===3&&r.center.every(Number.isFinite))
        const scene=graphScene(this.graph,previous)
        if(!demo&&nodes.length&&g.source!=='results')try{localStorage.setItem(registryKey,JSON.stringify(scene.placement))}catch{}
        const snapshot=this.orbit?.snapshot()
        this.orbit?.destroy();this.orbit=null;this.stage.replaceChildren()
        this.orbitIndex=scene.index
        if(nodes.length){
          const ordered=[...scene.index.keys()]
          this.orbit=mountOrbit(this.stage,scene.books,scene.edges,{
            isOpen:()=>this._open,
            close:()=>this.close(),
            toggleHits:()=>this.toggleHighlightHidden(),
            isPicking:()=>this._pickMode,
            onPick:index=>this.onPick?.(this.run.byId.get(ordered[index])),
            markdown:(value,inline)=>inline?mdInline(esc(value)):mdToHtml(value),
            snapshot:query===this._orbitQuery?snapshot:null,
            example:demo||g.source==='results',
          })
        }
        this._orbitKey=key
        this._orbitQuery=query
        this._orbitHighlight=undefined
        // 变更图数据时按原清单重算，不能把上一份图的邻居当成本轮命中。
        if(this.hl?.targets?.length&&nodes.length){
          const result=utils.computeExactSet(nodes,this.run.edges,this.hl.targets)
          this.hl.ids=result.ids
        }
      }
      this.showMessage(nodes.length?'':'会意图中暂无节点。',nodes.length||demo?null:()=>this.loadGraph(true,false),'载入演示拓扑')
      this.render()
      if(this._pendingChainFit){this._pendingChainFit=false;this._fitToChain()}
      return this.graph
    }catch(error){
      if(current()){
        this.showMessage('会意图加载失败。',()=>this.loadGraph(demo,free),'重试')
        console.warn('[CoRead] orbit graph load failed:',error)
      }
      return null
    }
  }
  showMessage(text,retry,label){
    this.message.hidden=!text
    this.fallbackClose.hidden=!text
    this.message.textContent=text
    if(retry){
      const button=document.createElement('button')
      button.type='button';button.textContent=label;button.onclick=retry
      this.message.append(button)
    }
  }
}
global.CoReadGraphView.GraphView=OrbitGraphView
})(window)
