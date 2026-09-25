(() => {
  const estado = {
    token: localStorage.getItem('token') || null,
    usuario: null,
    pin: '',
    unidadesPendentes: null,
    abaAtual: null,
  };

  async function api(caminho, opts = {}) {
    const resp = await fetch('/api' + caminho, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(estado.token ? { Authorization: `Bearer ${estado.token}` } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const dado = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(dado.erro || 'Erro na requisição');
    return dado;
  }

  // ---------- Login ----------
  const selCargo = document.getElementById('sel-cargo');
  const selPessoa = document.getElementById('sel-pessoa');
  const campoUnidade = document.getElementById('campo-unidade');
  const selUnidade = document.getElementById('sel-unidade');
  const pinDots = [...document.querySelectorAll('#pin-display span')];
  const erroLogin = document.getElementById('erro-login');

  async function carregarCargos() {
    const cargos = await api('/auth/cargos');
    selCargo.innerHTML = cargos.map((c) => `<option value="${c.id}">${esc(c.nome)}</option>`).join('');
    const cargoLembrado = localStorage.getItem('ultimoCargoId');
    if (cargoLembrado && cargos.some((c) => String(c.id) === cargoLembrado)) {
      selCargo.value = cargoLembrado;
    }
    await carregarPessoas();
  }

  async function carregarPessoas() {
    const cargoId = selCargo.value;
    if (!cargoId) return;
    const pessoas = await api(`/auth/pessoas?cargoId=${cargoId}`);
    selPessoa.innerHTML = pessoas.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('');
    const pessoaLembrada = localStorage.getItem('ultimaPessoaId');
    if (pessoaLembrada && pessoas.some((p) => String(p.id) === pessoaLembrada)) {
      selPessoa.value = pessoaLembrada;
    }
  }

  selCargo.addEventListener('change', carregarPessoas);

  function atualizarPinDisplay() {
    pinDots.forEach((dot, i) => dot.classList.toggle('preenchido', i < estado.pin.length));
  }

  function limparPin() {
    estado.pin = '';
    erroLogin.textContent = '';
    atualizarPinDisplay();
  }

  async function tentarLogin() {
    const pessoaId = Number(selPessoa.value);
    if (!pessoaId || estado.pin.length !== 4) return;
    try {
      const unidadeId = campoUnidade.classList.contains('oculto') ? undefined : Number(selUnidade.value);
      const resposta = await api('/auth/login', { method: 'POST', body: { pessoaId, pin: estado.pin, unidadeId } });

      if (resposta.precisaUnidade) {
        estado.unidadesPendentes = resposta.unidades;
        selUnidade.innerHTML = resposta.unidades.map((u) => `<option value="${u.id}">${esc(u.nome)}</option>`).join('');
        campoUnidade.classList.remove('oculto');
        limparPin();
        return;
      }

      localStorage.setItem('token', resposta.token);
      localStorage.setItem('ultimoCargoId', selCargo.value);
      localStorage.setItem('ultimaPessoaId', selPessoa.value);
      estado.token = resposta.token;
      estado.usuario = resposta.usuario;
      entrarNoApp();
    } catch (err) {
      erroLogin.textContent = err.message;
      limparPin();
    }
  }

  document.getElementById('teclado-pin').addEventListener('click', (e) => {
    const tecla = e.target.dataset.tecla;
    if (!tecla) return;
    if (tecla === 'limpar') return limparPin();
    if (tecla === 'apagar') { estado.pin = estado.pin.slice(0, -1); atualizarPinDisplay(); return; }
    if (estado.pin.length < 4) {
      estado.pin += tecla;
      atualizarPinDisplay();
      if (estado.pin.length === 4) tentarLogin();
    }
  });

  document.onkeydown = (e) => {
    if (estado.token) return; // teclado físico só ativo antes de logar
    if (e.key >= '0' && e.key <= '9') {
      if (estado.pin.length < 4) {
        estado.pin += e.key;
        atualizarPinDisplay();
        if (estado.pin.length === 4) tentarLogin();
      }
    } else if (e.key === 'Backspace') {
      estado.pin = estado.pin.slice(0, -1);
      atualizarPinDisplay();
    } else if (e.key === 'Escape') {
      limparPin();
    }
  };

  // ---------- Sidebar / shell ----------
  const app = document.getElementById('app');
  const telaLogin = document.getElementById('tela-login');
  const sidebar = document.getElementById('sidebar');
  const btnEsconder = document.getElementById('btn-esconder');
  const btnMostrar = document.getElementById('btn-mostrar');
  const backdrop = document.getElementById('backdrop');
  const listaAbas = document.getElementById('lista-abas');
  const conteudo = document.getElementById('conteudo');

  function ehMobile() { return window.matchMedia('(max-width: 720px)').matches; }

  function aplicarEstadoSidebar() {
    if (ehMobile()) {
      sidebar.classList.remove('escondida');
      btnMostrar.classList.add('oculto');
      return;
    }
    const escondida = localStorage.getItem('sidebarEscondida') === '1';
    sidebar.classList.toggle('escondida', escondida);
    btnMostrar.classList.toggle('oculto', !escondida);
  }

  btnEsconder.addEventListener('click', () => {
    if (ehMobile()) {
      sidebar.classList.remove('aberta-mobile');
      backdrop.style.display = 'none';
      return;
    }
    localStorage.setItem('sidebarEscondida', '1');
    aplicarEstadoSidebar();
  });

  btnMostrar.addEventListener('click', () => {
    if (ehMobile()) {
      sidebar.classList.add('aberta-mobile');
      backdrop.style.display = 'block';
      return;
    }
    localStorage.setItem('sidebarEscondida', '0');
    aplicarEstadoSidebar();
  });

  backdrop.addEventListener('click', () => {
    sidebar.classList.remove('aberta-mobile');
    backdrop.style.display = 'none';
  });

  window.addEventListener('resize', aplicarEstadoSidebar);

  async function entrarNoApp() {
    telaLogin.classList.add('oculto');
    app.classList.add('logado');
    document.getElementById('nome-usuario').textContent = estado.usuario.nome;
    document.getElementById('cargo-usuario').textContent = estado.usuario.cargoNome;

    if (!localStorage.getItem('sidebarEscondida')) {
      localStorage.setItem('sidebarEscondida', ehMobile() ? '1' : '0');
    }
    aplicarEstadoSidebar();

    const abas = await api('/auth/me/abas');
    if (estado.usuario.administrador) abas.push({ id: 'config', nome: 'Configurações' });

    listaAbas.innerHTML = abas.map((a) => `
      <li><a href="#" data-aba="${a.id}">${esc(a.nome)}</a></li>
    `).join('');

    listaAbas.addEventListener('click', (e) => {
      const link = e.target.closest('a[data-aba]');
      if (!link) return;
      e.preventDefault();
      abrirAba(link.dataset.aba);
      if (ehMobile()) { sidebar.classList.remove('aberta-mobile'); backdrop.style.display = 'none'; }
    });

    abrirAba(abas[0]?.id);
  }

  function marcarAbaAtiva(id) {
    listaAbas.querySelectorAll('a').forEach((a) => a.classList.toggle('ativa', a.dataset.aba === id));
  }

  async function abrirAba(id) {
    if (!id) return;
    estado.abaAtual = id;
    marcarAbaAtiva(id);
    if (id === 'config') return renderConfiguracoes();
    conteudo.innerHTML = `<h2>${esc(nomeDaAba(id))}</h2><p class="placeholder">Tela ainda não desenhada — depende do que o Pedro trouxer da visita à associação.</p>`;
  }

  function nomeDaAba(id) {
    const link = listaAbas.querySelector(`a[data-aba="${id}"]`);
    return link ? link.textContent : id;
  }

  // ---------- Configurações ----------
  async function renderConfiguracoes() {
    conteudo.innerHTML = `
      <h2>Configurações</h2>
      <div class="secao">
        <h3>Unidades</h3>
        <div id="lista-unidades"></div>
        <div class="linha-form">
          <input id="nova-unidade-nome" placeholder="Nome da unidade" />
          <button class="botao" id="btn-add-unidade">Adicionar</button>
        </div>
      </div>
      <div class="secao">
        <h3>Cargos</h3>
        <div id="lista-cargos"></div>
        <div class="linha-form">
          <input id="novo-cargo-nome" placeholder="Nome do cargo" />
          <button class="botao" id="btn-add-cargo">Adicionar</button>
        </div>
      </div>
      <div class="secao">
        <h3>Permissões por cargo</h3>
        <div id="tabela-permissoes"></div>
      </div>
    `;

    const unidades = await api('/config/unidades');
    document.getElementById('lista-unidades').innerHTML = unidades
      .map((u) => `<div>${esc(u.nome)}</div>`).join('') || '<p class="placeholder">Nenhuma unidade cadastrada.</p>';

    const cargos = await api('/config/cargos');
    document.getElementById('lista-cargos').innerHTML = cargos
      .map((c) => `<div>${esc(c.nome)}${c.administrador ? ' (irrestrito)' : ''}</div>`).join('');

    document.getElementById('btn-add-unidade').addEventListener('click', async () => {
      const campo = document.getElementById('nova-unidade-nome');
      if (!campo.value.trim()) return;
      await api('/config/unidades', { method: 'POST', body: { nome: campo.value.trim() } });
      renderConfiguracoes();
    });

    document.getElementById('btn-add-cargo').addEventListener('click', async () => {
      const campo = document.getElementById('novo-cargo-nome');
      if (!campo.value.trim()) return;
      await api('/config/cargos', { method: 'POST', body: { nome: campo.value.trim() } });
      renderConfiguracoes();
    });

    const { abas, matriz } = await api('/config/permissoes');
    const tabela = document.getElementById('tabela-permissoes');
    tabela.innerHTML = `
      <table class="permissoes">
        <thead><tr><th>Cargo</th>${abas.map((a) => `<th>${esc(a.nome)}</th>`).join('')}</tr></thead>
        <tbody>
          ${matriz.map((linha) => `
            <tr data-cargo="${linha.cargoId}">
              <td>${esc(linha.cargoNome)}</td>
              ${linha.abas.map((a) => `<td><input type="checkbox" data-aba="${a.aba}" ${a.permitido ? 'checked' : ''}></td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="linha-form"><button class="botao" id="btn-salvar-permissoes">Salvar permissões</button></div>
    `;

    document.getElementById('btn-salvar-permissoes').addEventListener('click', async () => {
      const itens = [];
      tabela.querySelectorAll('tr[data-cargo]').forEach((tr) => {
        const cargoId = Number(tr.dataset.cargo);
        tr.querySelectorAll('input[data-aba]').forEach((chk) => {
          itens.push({ cargoId, aba: chk.dataset.aba, permitido: chk.checked });
        });
      });
      await api('/config/permissoes', { method: 'PUT', body: { itens } });
    });
  }

  // ---------- Início ----------
  (async function iniciar() {
    await carregarCargos();
    if (estado.token) {
      try {
        estado.usuario = await api('/auth/me');
        entrarNoApp();
      } catch {
        localStorage.removeItem('token');
        estado.token = null;
      }
    }
  })();
})();
