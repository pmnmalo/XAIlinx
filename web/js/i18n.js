// Interface internationalisation.
//
// The UI is written in English; this module translates the visible text of the page (text nodes,
// title/placeholder/aria-label attributes, option labels) from per-language dictionaries, and keeps
// translating whatever the app adds later (dialogs, menus, ISim, editors) through a MutationObserver.
// User content is never translated: code editors, the console (tool output), the design hierarchy,
// schematic/waveform drawings and anything inside [data-no-i18n].
//
// Add a language: add an entry to LOCALES ({ name, strings: { "English text": "translation" },
// patterns: [[/regex/, "replacement with $1"]] }). Strings missing from a dictionary stay in English.
// Code can also call t('English text') directly.

import { TT_PT, TT_PT_PATTERNS } from './i18n-truthtable.js';
import { IO_PT, IO_PT_PATTERNS } from './i18n-inout.js';
import { LINT_PT } from './i18n-lint.js';
import { FSM_PT, FSM_PT_PATTERNS } from './i18n-fsm.js';
import { FPGA_PT, FPGA_PT_PATTERNS } from './i18n-fpga.js';

const PT = {
  // menus
  'File': 'Ficheiro', 'Edit': 'Editar', 'View': 'Ver', 'Project': 'Projeto', 'Process': 'Processo', 'Tools': 'Ferramentas',
  'Window': 'Janela', 'Help': 'Ajuda', 'Language': 'Idioma',
  'New Project…': 'Novo Projeto…', 'Open Project…': 'Abrir Projeto…', 'Close Project': 'Fechar Projeto',
  'Import Xilinx ISE Project (.zip)…': 'Importar Projeto Xilinx ISE (.zip)…', 'Export Xilinx ISE Project (.zip)…': 'Exportar Projeto Xilinx ISE (.zip)…',
  'Import Silinx ISE Project (.zip)…': 'Importar Projeto Silinx ISE (.zip)…', 'Export Silinx ISE Project (.zip)…': 'Exportar Projeto Silinx ISE (.zip)…',
  'Download Project Bundle…': 'Descarregar Pacote do Projeto…', 'Open Project Bundle…': 'Abrir Pacote do Projeto…',
  'New Source…': 'Nova Fonte…', 'Save': 'Guardar', 'Save All': 'Guardar Tudo', 'Recent Projects': 'Projetos Recentes',
  'Undo': 'Anular', 'Redo': 'Refazer', 'Replace…': 'Substituir…', 'Go to Line…': 'Ir para a Linha…',
  'Implementation': 'Implementação', 'Simulation': 'Simulação',
  'Design Summary': 'Resumo do Projeto', 'Add Source…': 'Adicionar Fonte…', 'Add Copy of Source…': 'Adicionar Cópia de Fonte…',
  'Set as Top Module': 'Definir como Módulo de Topo', 'Set as Simulation Top': 'Definir como Topo de Simulação',
  'Design Properties…': 'Propriedades do Projeto…', 'Sync with .xise': 'Sincronizar com .xise',
  'Implement Top Module': 'Implementar Módulo de Topo', 'Run': 'Executar', 'Check Syntax': 'Verificar Sintaxe',
  'Simulate Behavioral Model': 'Simular Modelo Comportamental', 'ASM State Machine Editor…': 'Editor de Máquinas de Estados ASM…',
  'I/O Pin Planning': 'Planeamento de Pinos de E/S', 'iMPACT (Configure Target Device)': 'iMPACT (Configurar Dispositivo)',
  'RTL Schematic': 'Esquemático RTL', 'Toolchain Settings (ISE / Programmers)…': 'Definições da Toolchain (ISE / Programadores)…',
  'Close All Documents': 'Fechar Todos os Documentos', 'Digital design platform for Xilinx FPGAs (Spartan-3/3A/3E/6, Virtex-4/5/6, 7-series with ISE 14.7), made for teaching: mixed VHDL/Verilog projects; schematics with live simulation; FSM and ASM state machine editors; truth tables and Karnaugh maps; module and test bench wizards; behavioural and netlist simulation with waveforms; a board emulator; synthesis, implementation and device programming with ISE.': 'Plataforma de projeto digital para FPGAs Xilinx (Spartan-3/3A/3E/6, Virtex-4/5/6, série 7 com o ISE 14.7), feita para o ensino: projetos VHDL/Verilog mistos; esquemáticos com simulação em tempo real; editores de máquinas de estados FSM e ASM; tabelas de verdade e mapas de Karnaugh; assistentes de módulos e de bancadas de teste; simulação comportamental e de netlist com formas de onda; um emulador da placa; síntese, implementação e programação do dispositivo com o ISE.', 'Component': 'Componente', ', with an additional permission for elkjs:': ', com uma permissão adicional para o elkjs:', 'This program comes with ABSOLUTELY NO WARRANTY. Source code:': 'Este programa NÃO TEM QUALQUER GARANTIA. Código-fonte:', 'Each keeps its own licence; the full texts are in': 'Cada um mantém a sua própria licença; os textos completos estão em', '. elkjs (EPL-2.0) source code:': '. Código-fonte do elkjs (EPL-2.0):', 'Licence': 'Licença', 'Version': 'Versão', "What's new:": 'Novidades:', 'Undo Remove from Project': 'Anular Remover do Projeto', 'Redo Remove from Project': 'Refazer Remover do Projeto', 'Not in project': 'Fora do projeto', 'Add to Project': 'Acrescentar ao Projeto', 'The example has its own sources.': 'O exemplo tem as suas próprias fontes.', 'No vectors: a test bench skeleton (clock, reset and the module); I will write the stimulus': 'Sem vetores: um esqueleto de bancada de teste (relógio, reset e o módulo); eu escrevo os estímulos', 'Test Benches:': 'Bancadas de Teste:', 'Implementation only': 'Só implementação', 'HDL Module': 'Módulo HDL', 'Test Bench (HDL)': 'Bancada de Teste (HDL)', 'Test Bench (Wizard)': 'Bancada de Teste (Assistente)', 'State Machine (ASM)': 'Máquina de Estados (ASM)', 'New Test Bench (Wizard)…': 'Nova Bancada de Teste (Assistente)…', 'Create Test Bench (Wizard)…': 'Criar Bancada de Teste (Assistente)…', 'Test Bench Wizard': 'Assistente de Bancada de Teste', 'Unit Under Test': 'Unidade em Teste', 'Clock and Reset': 'Relógio e Reset', 'Input Vectors': 'Vetores de Entrada', 'Vectors and Expected Outputs': 'Vetores e Saídas Esperadas', 'Module to test:': 'Módulo a testar:', 'Test bench name:': 'Nome da bancada de teste:', 'Clock port:': 'Porto de relógio:', 'Clock period (ns):': 'Período do relógio (ns):', 'Reset port:': 'Porto de reset:', 'Reset level:': 'Nível do reset:', 'Reset for (clock cycles):': 'Reset durante (ciclos de relógio):', 'Settling time (ns):': 'Tempo de estabilização (ns):', 'Number of vectors:': 'Número de vetores:', 'Random seed:': 'Semente aleatória:', 'Fill Expected from Current Design': 'Preencher Esperados a partir do Projeto Atual', 'Clear Expected': 'Limpar Esperados', 'Add Vector': 'Adicionar Vetor', 'input': 'entrada', 'expected output': 'saída esperada', 'Delete this vector': 'Apagar este vetor', 'Every combination of the inputs (exhaustive test)': 'Todas as combinações das entradas (teste exaustivo)', 'Random vectors': 'Vetores aleatórios', 'Counting (all inputs as one number: 0, 1, 2, …)': 'Contagem (todas as entradas como um número: 0, 1, 2, …)', 'Walking ones and zeros (all 0, all 1, then one bit at a time)': 'Uns e zeros deslizantes (tudo a 0, tudo a 1, depois um bit de cada vez)', 'I will type the vectors in (starts with one empty vector)': 'Vou escrever os vetores (começa com um vetor vazio)', 'Rename Folder…': 'Mudar o Nome da Pasta…', 'Delete Folder…': 'Apagar Pasta…', 'Rename Folder': 'Mudar o Nome da Pasta', 'Delete Folder': 'Apagar Pasta', 'About Silinx ISE': 'Acerca do Silinx ISE', 'Keyboard Shortcuts': 'Atalhos de Teclado',
  'Close': 'Fechar', 'Close Others': 'Fechar Outros', 'Close All': 'Fechar Todos', 'Open': 'Abrir', 'Remove from Project': 'Remover do Projeto',
  'Source Properties…': 'Propriedades da Fonte…', 'Rerun': 'Executar Novamente', 'Stop': 'Parar', 'Schematic': 'Esquemático', 'View/Edit Schematic': 'Ver/Editar Esquemático', 'Convert to HDL': 'Converter para HDL', '⬆ Up': '⬆ Subir', '⬇ Push into': '⬇ Entrar', 'Up to the parent module (Backspace)': 'Subir para o módulo pai (Backspace)', 'Push into the selected instance (Enter, or double-click it)': 'Entrar na instância selecionada (Enter, ou duplo clique)', 'Rename…': 'Mudar o Nome…', 'File name follows the module name': 'O nome do ficheiro acompanha o nome do módulo', 'Rename': 'Mudar o Nome', 'Entity:': 'Entidade:', 'Convert to State Machine (ASM)…': 'Converter para Máquina de Estados (ASM)…', 'Convert to State Machine (state machine as base)': 'Converter para Máquina de Estados (máquina de estados como base)', 'Remove Synchronized State Machine…': 'Remover Máquina de Estados Sincronizada…', '(synchronized state machine)': '(máquina de estados sincronizada)', 'Open Synchronized State Machine': 'Abrir Máquina de Estados Sincronizada', 'Check Constraints': 'Verificar Restrições', 'Export as ISE Schematic (.sch)…': 'Exportar como Esquemático ISE (.sch)…', 'Check Syntax of this file': 'Verificar a sintaxe deste ficheiro', ' Check Syntax': ' Verificar Sintaxe', 'Toggle Comment': 'Comentar/Descomentar', 'Find…': 'Procurar…', 'Language Templates': 'Modelos de Linguagem', 'Instantiate module': 'Instanciar módulo', 'Open Synchronized Schematic': 'Abrir Esquemático Sincronizado', 'Select All': 'Selecionar Tudo', 'Convert to HDL (HDL as base)': 'Converter para HDL (HDL como base)', 'Convert to Schematic (schematic as base)': 'Converter para Esquemático (esquemático como base)', 'Remove Synchronized Schematic…': 'Remover Esquemático Sincronizado…', '(synchronized schematic)': '(esquemático sincronizado)', ' (schematic view of this file) — saving here updates it': ' (vista em esquemático deste ficheiro) — guardar aqui atualiza-o', 'RTL Schematic (read-only)': 'Esquemático RTL (só de leitura)', 'Open this instance': 'Abrir esta instância', 'Read-only view. Drag on empty space to select, double-click a module to open it, wheel to zoom.': 'Vista só de leitura. Arraste numa área vazia para selecionar, duplo-clique num módulo para o abrir, roda para zoom.', 'Convert to Schematic (editable)…': 'Converter para Esquemático (editável)…', 'Synchronized with ': 'Sincronizado com ', ' — saving here updates the schematic': ' — guardar aqui atualiza o esquemático', '(synchronized HDL)': '(HDL sincronizado)', 'An implementation is already running (use Stop to cancel it)': 'Já está uma implementação em curso (use Parar para a cancelar)', 'Stop the running process': 'Parar o processo em curso', 'No process is running': 'Nenhum processo em curso', 'Process Properties…': 'Propriedades do Processo…',
  // toolbar / panels
  'New Project': 'Novo Projeto', 'Open Project': 'Abrir Projeto', 'Save (Ctrl+S)': 'Guardar (Ctrl+S)', 'Cut': 'Cortar', 'Copy': 'Copiar',
  'Paste': 'Colar', 'Find': 'Procurar', 'View RTL Schematic': 'Ver Esquemático RTL', 'New ASM State Diagram': 'Novo Diagrama de Estados ASM',
  'Configure Target Device (iMPACT)': 'Configurar Dispositivo (iMPACT)', 'Toolchain Settings': 'Definições da Toolchain', 'About': 'Acerca de',
  'Design': 'Projeto', 'View:': 'Vista:', 'Hierarchy': 'Hierarquia', 'Processes:': 'Processos:', 'Start': 'Início', 'Files': 'Ficheiros',
  'Libraries': 'Bibliotecas', 'Console': 'Consola', 'Errors': 'Erros', 'Warnings': 'Avisos', 'Ready': 'Pronto', 'Clear': 'Limpar',
  'Project Commands': 'Comandos do Projeto', 'Open Example (blinky)': 'Abrir Exemplo (blinky)', 'No projects yet.': 'Ainda não há projetos.',
  'File Name': 'Nome do Ficheiro', 'Association': 'Associação', 'Behavioral': 'Comportamental',
  // processes
  'Design Summary/Reports': 'Resumo do Projeto/Relatórios', 'Design Utilities': 'Utilitários de Projeto',
  'View HDL Instantiation Template': 'Ver Modelo de Instanciação HDL', 'User Constraints': 'Restrições do Utilizador',
  'Edit Constraints (Text)': 'Editar Restrições (Texto)', 'Synthesize - XST': 'Sintetizar - XST', 'Implement Design': 'Implementar Projeto',
  'Translate': 'Traduzir', 'Map': 'Mapear', 'Place & Route': 'Posicionar e Encaminhar', 'Generate Programming File': 'Gerar Ficheiro de Programação',
  'Configure Target Device': 'Configurar Dispositivo', 'Manage Configuration Project (iMPACT)': 'Gerir Projeto de Configuração (iMPACT)',
  'ISim Simulator': 'Simulador ISim', 'Behavioral Check Syntax': 'Verificar Sintaxe (Comportamental)',
  'View/Edit State Diagram (ASM)': 'Ver/Editar Diagrama de Estados (ASM)', 'No processes for the selected item': 'Sem processos para o item selecionado',
  // dialogs & wizards
  'Cancel': 'Cancelar', 'Yes': 'Sim', 'No': 'Não', 'Next >': 'Seguinte >', '< Back': '< Anterior', 'Finish': 'Concluir', 'Import': 'Importar',
  'New Project Wizard': 'Assistente de Novo Projeto', 'Create New Project': 'Criar Novo Projeto', 'Project Settings': 'Definições do Projeto',
  'Project Summary': 'Resumo do Projeto', 'Enter a name and location for the project.': 'Indique um nome e uma localização para o projeto.',
  'Name:': 'Nome:', 'Location:': 'Localização:', 'Top-level source type:': 'Tipo de fonte de topo:', 'Start from:': 'Começar a partir de:',
  'Empty project': 'Projeto vazio', 'Projects are stored in the Silinx workspace folder (default ~/Silinx-projects).': 'Os projetos são guardados na pasta de trabalho do Silinx (por omissão ~/Silinx-projects).',
  'Select the device and design flow for the project.': 'Selecione o dispositivo e o fluxo de projeto.',
  'Evaluation Development Board:': 'Placa de Desenvolvimento:', 'Product Category:': 'Categoria de Produto:', 'Family:': 'Família:',
  'Device:': 'Dispositivo:', 'Package:': 'Encapsulamento:', 'Speed:': 'Velocidade:', 'Top-Level Source Type:': 'Tipo de Fonte de Topo:',
  'Synthesis Tool:': 'Ferramenta de Síntese:', 'Simulator:': 'Simulador:', 'Preferred Language:': 'Linguagem Preferida:',
  'VHDL Source Analysis Standard:': 'Norma de Análise VHDL:', 'None Specified': 'Nenhuma', 'All': 'Todas',
  'Project name must start with a letter and contain only letters, digits and _.': 'O nome do projeto deve começar por uma letra e conter apenas letras, dígitos e _.',
  'No projects found in the workspace.': 'Não foram encontrados projetos na pasta de trabalho.',
  'Import Xilinx ISE Project': 'Importar Projeto Xilinx ISE', 'Export Xilinx ISE Project': 'Exportar Projeto Xilinx ISE',
  'Import Silinx ISE Project': 'Importar Projeto Silinx ISE', 'Export Silinx ISE Project': 'Exportar Projeto Silinx ISE', 'File(s):': 'Ficheiro(s):', 'Project name:': 'Nome do projeto:',
  'Select a .zip of the ISE project folder (the .xise and its sources — e.g. one exported with File ▸ Export Xilinx ISE Project).': 'Selecione um .zip da pasta do projeto ISE (o .xise e as suas fontes — p. ex. um exportado com Ficheiro ▸ Exportar Projeto Xilinx ISE).',
  'Select a .zip (or a .xise with its sources).': 'Selecione um .zip (ou um .xise com as suas fontes).',
  'Project folder:': 'Pasta do projeto:', 'or .zip / .xise file(s):': 'ou ficheiro(s) .zip / .xise:',
  'Select the project folder, a .zip, or a .xise with its sources.': 'Selecione a pasta do projeto, um .zip, ou um .xise com as suas fontes.',
  'ISE output files in the folder (xst, _ngo, netlists, bitstreams, logs) are not imported.': 'Os ficheiros gerados pelo ISE na pasta (xst, _ngo, netlists, bitstreams, logs) não são importados.',
  'Import an ISE project from its folder (the folder with the .xise file), or from a .zip of that folder (e.g. one exported with File ▸ Export Xilinx ISE Project).': 'Importe um projeto ISE a partir da sua pasta (a pasta com o ficheiro .xise), ou de um .zip dessa pasta (p. ex. um exportado com Ficheiro ▸ Exportar Projeto Xilinx ISE).',
  'New Source Wizard': 'Assistente de Nova Fonte', 'Select Source Type': 'Selecionar Tipo de Fonte', 'File name:': 'Nome do ficheiro:',
  'Add to project': 'Adicionar ao projeto', 'Define Module': 'Definir Módulo', 'Entity / Module name:': 'Nome da entidade / módulo:',
  'Architecture name:': 'Nome da arquitetura:', 'Port Name': 'Nome do Porto', 'Direction': 'Direção', 'Associate Source': 'Associar Fonte',
  'Select the source (Unit Under Test) to associate with the new test bench.': 'Selecione a fonte (Unidade em Teste) a associar ao novo test bench.',
  'Summary': 'Resumo', 'Options': 'Opções', 'VHDL Module': 'Módulo VHDL', 'Verilog Module': 'Módulo Verilog', 'VHDL Test Bench': 'Test Bench VHDL',
  'Verilog Test Fixture': 'Test Fixture Verilog', 'VHDL Package': 'Pacote VHDL', 'ASM State Diagram (State Machine)': 'Diagrama de Estados ASM (Máquina de Estados)',
  'Implementation Constraints File': 'Ficheiro de Restrições de Implementação', 'Memory Initialization File (.mem)': 'Ficheiro de Inicialização de Memória (.mem)',
  'Enter a valid file name (letters, digits, _ and -).': 'Indique um nome de ficheiro válido (letras, dígitos, _ e -).', 'Invalid location.': 'Localização inválida.',
  'Invalid module name.': 'Nome de módulo inválido.', 'Duplicate port names.': 'Nomes de portos repetidos.', 'Select a module.': 'Selecione um módulo.',
  'No design modules in the project.': 'Não há módulos de projeto.', 'Add Source': 'Adicionar Fonte', 'Add Copy of Source': 'Adicionar Cópia de Fonte', 'Project:': 'Projeto:', 'Check for Updates…': 'Procurar Atualizações…', 'Emulate on Board (RTL)': 'Emular na Placa (RTL)', 'Emulate on Board': 'Emular na Placa', 'Emulate Behavioral Model (RTL)': 'Emular Modelo Comportamental (RTL)',
  'Emulate Post-Synthesis Model': 'Emular Modelo Pós-Síntese', 'Emulate Post-Translate Model': 'Emular Modelo Pós-Translate',
  'Emulate Post-Map Model': 'Emular Modelo Pós-Map', 'Emulate Post-Place & Route Model': 'Emular Modelo Pós-Place & Route',
  'View Technology Schematic': 'Ver Esquemático Tecnológico',
  'Generate Post-Synthesis Simulation Model': 'Gerar Modelo de Simulação Pós-Síntese', 'Generate Post-Translate Simulation Model': 'Gerar Modelo de Simulação Pós-Translate',
  'Generate Post-Map Simulation Model': 'Gerar Modelo de Simulação Pós-Map', 'Generate Post-Place & Route Simulation Model': 'Gerar Modelo de Simulação Pós-Place & Route',
  'Generate Post-Place & Route Static Timing': 'Gerar Análise Temporal Estática Pós-Place & Route', 'Generate Text Power Report': 'Gerar Relatório de Consumo (Texto)',
  'Back-annotate Pin Locations': 'Anotar a Localização dos Pinos',
  'Simulate Post-Synthesis Model': 'Simular Modelo Pós-Síntese', 'Simulate Post-Translate Model': 'Simular Modelo Pós-Translate',
  'Simulate Post-Map Model': 'Simular Modelo Pós-Map', 'Simulate Post-Place & Route Model': 'Simular Modelo Pós-Place & Route', 'Board Emulator': 'Emulador da Placa', 'Check for Updates': 'Procurar Atualizações', 'Developers:': 'Programadores:', 'developed with Claude (Anthropic)': 'desenvolvido com Claude (Anthropic)', 'Silinx ISE was developed for educational purposes, specifically to support the teaching of Digital Systems, because AMD/Xilinx discontinued support for Xilinx ISE a long time ago.': 'O Silinx ISE foi desenvolvido para fins educativos, especificamente para apoiar o ensino de Sistemas Digitais, porque a AMD/Xilinx descontinuou o suporte ao Xilinx ISE há muito tempo.', 'Files:': 'Ficheiros:', 'Association:': 'Associação:',
  'All (Implementation + Simulation)': 'Todas (Implementação + Simulação)', 'Simulation only': 'Só simulação', 'File:': 'Ficheiro:', 'Language:': 'Linguagem:',
  'View Association:': 'Associação de Vista:', 'Design Properties': 'Propriedades do Projeto', 'Top Module (implementation):': 'Módulo de Topo (implementação):',
  'Top Module (simulation):': 'Módulo de Topo (simulação):', 'Optimization Goal:': 'Objetivo de Otimização:', 'Optimization Effort:': 'Esforço de Otimização:',
  'FPGA Start-Up Clock:': 'Relógio de Arranque da FPGA:', 'Speed': 'Velocidade', 'Area': 'Área', 'High': 'Alto', 'Normal': 'Normal',
  'JTAG Clock': 'Relógio JTAG', 'User Clock': 'Relógio do Utilizador', 'Process Properties - Synthesis / Implementation / Bitstream': 'Propriedades do Processo - Síntese / Implementação / Bitstream',
  'Execution mode:': 'Modo de execução:', 'Local (Xilinx ISE installed locally)': 'Local (Xilinx ISE instalado localmente)',
  'Docker image with Xilinx ISE': 'Imagem Docker com Xilinx ISE', 'Remote host with Xilinx ISE via SSH': 'Máquina remota com Xilinx ISE por SSH',
  'ISE settings64.sh:': 'settings64.sh do ISE:', 'Docker image:': 'Imagem Docker:', 'Host:': 'Servidor:', 'User:': 'Utilizador:', 'Port:': 'Porto:',
  'Remote build dir:': 'Pasta remota de build:', 'Remote settings64.sh:': 'settings64.sh remoto:', 'Docker image on the remote host:': 'Imagem Docker na máquina remota:', 'none: ISE installed on the host': 'nenhuma: ISE instalado na máquina', 'Programmer tool:': 'Ferramenta de programação:',
  'Cable:': 'Cabo:', 'Device programmers': 'Programadores de dispositivos', 'Tool': 'Ferramenta', 'Location': 'Localização',
  'Board default': 'Predefinição da placa', 'board default': 'predefinição da placa', 'Save Changes': 'Guardar Alterações', 'Set Top Module': 'Definir Módulo de Topo',
  'Remove Source': 'Remover Fonte', 'Update Constraints': 'Atualizar Restrições', 'Constraints do not match the board': 'As restrições não correspondem à placa',
  'Version 0.1': 'Versão 0.1',
  // design summary
  'Project File:': 'Ficheiro do Projeto:', 'Module Name:': 'Nome do Módulo:', 'Target Device:': 'Dispositivo Alvo:', 'Board:': 'Placa:',
  'Product Version:': 'Versão do Produto:', 'Design Goal:': 'Objetivo do Projeto:', 'Parser Errors:': 'Erros de Análise:',
  'Implementation State:': 'Estado da Implementação:', 'Warnings:': 'Avisos:', 'Simulation Top:': 'Topo de Simulação:', 'Constraints:': 'Restrições:',
  'Sources:': 'Fontes:', 'No Errors': 'Sem Erros', 'No Warnings': 'Sem Avisos', 'New': 'Novo', 'Synthesized': 'Sintetizado', 'Mapped': 'Mapeado',
  'Placed and Routed': 'Posicionado e Encaminhado', 'Programming File Generated': 'Ficheiro de Programação Gerado',
  'Device Utilization Summary': 'Resumo da Utilização do Dispositivo', 'Logic Utilization': 'Utilização Lógica', 'Used': 'Usado',
  'Available': 'Disponível', 'Utilization': 'Utilização', 'Timing (post Place & Route)': 'Temporização (após Posicionar e Encaminhar)',
  'Timing Constraints': 'Restrições de Temporização', 'All constraints met': 'Todas as restrições cumpridas', 'Minimum period': 'Período mínimo',
  'Programming File': 'Ficheiro de Programação', 'Bitstream': 'Bitstream', 'Part': 'Componente', 'Generated': 'Gerado', 'Detailed Reports': 'Relatórios Detalhados',
  'Report Name': 'Nome do Relatório', 'Status': 'Estado', 'Synthesis Report': 'Relatório de Síntese', 'Map Report': 'Relatório de Mapeamento',
  'Place and Route Report': 'Relatório de Posicionamento e Encaminhamento', 'Post-PAR Static Timing Report': 'Relatório de Temporização Estática pós-PAR',
  'Bitgen Report': 'Relatório do Bitgen', 'Current': 'Atual', '(not set)': '(não definido)', '(none)': '(nenhum)',
  // pin planner
  'Save Constraints': 'Guardar Restrições', 'Auto-assign from Board': 'Atribuir Automaticamente pela Placa', 'Clear All': 'Limpar Tudo',
  'I/O Name': 'Nome de E/S', 'Board Resource': 'Recurso da Placa', 'Site (LOC)': 'Pino (LOC)', 'I/O Std.': 'Norma de E/S', 'Drive': 'Corrente',
  'Slew': 'Slew', 'Pull': 'Pull', 'Clock period (ns)': 'Período do relógio (ns)', 'Input': 'Entrada', 'Output': 'Saída', 'Bidir': 'Bidir.',
  'Select a board in Design Properties': 'Selecione uma placa nas Propriedades do Projeto',
  'Match port names with board resources (clk, led, sw, btn, seg, an…)': 'Associar nomes de portos aos recursos da placa (clk, led, sw, btn, seg, an…)',
  'No board selected. Choose one in Project ▸ Design Properties to see the board resources and auto-assign pins.': 'Nenhuma placa selecionada. Escolha uma em Projeto ▸ Propriedades do Projeto para ver os recursos da placa e atribuir pinos automaticamente.',
  // iMPACT
  'Programming tool:': 'Ferramenta de programação:', 'Configuration file (.bit):': 'Ficheiro de configuração (.bit):',
  'Initialize Chain (Scan)': 'Inicializar Cadeia (Scan)', 'Program FPGA': 'Programar FPGA', 'Program PROM': 'Programar PROM', 'Verify': 'Verificar',
  'Erase': 'Apagar', 'Back up PROM': 'Copiar PROM', 'Reload FPGA from PROM': 'Recarregar FPGA a partir da PROM',
  'Verify after programming': 'Verificar após programar', 'Reload the FPGA from the PROM afterwards (mode jumper on ROM)': 'Recarregar a FPGA a partir da PROM no fim (jumper de modo em ROM)',
  'Loads the FPGA directly (volatile: lost at power-off). Select the PROM in the chain to store the design in flash.': 'Carrega a FPGA diretamente (volátil: perde-se ao desligar). Selecione a PROM na cadeia para guardar o projeto na flash.',
  'Program': 'Programar', 'Erase PROM': 'Apagar PROM', 'No board selected: choose the programming tool and cable explicitly.': 'Nenhuma placa selecionada: escolha a ferramenta e o cabo de programação.',
  'Another operation is running': 'Outra operação está em curso', 'Failed — see console': 'Falhou — ver consola', 'Scan finished.': 'Scan concluído.',
  // editor
  'Templates ▾': 'Modelos ▾', 'Find (Ctrl+F)': 'Procurar (Ctrl+F)', 'Auto-complete': 'Completar automaticamente',
  'Toggle comment': 'Comentar/descomentar', 'Find / Replace': 'Procurar / Substituir', 'Go to line': 'Ir para a linha', 'Go to definition': 'Ir para a definição',
  'Fold block': 'Dobrar bloco', 'Run process': 'Executar processo', 'Push into instance': 'Entrar na instância',
  'Double-click process': 'Duplo clique num processo', 'Double-click instance (schematic)': 'Duplo clique numa instância (esquemático)',
  // ISim
  'Instances and Processes': 'Instâncias e Processos', 'Objects': 'Objetos', 'Object Name': 'Nome do Objeto', 'Value': 'Valor', 'Data Type': 'Tipo de Dados',
  'Name': 'Nome', 'Restart': 'Reiniciar', 'Run All': 'Executar Tudo', 'Break': 'Parar', 'Run for the specified time': 'Executar durante o tempo indicado',
  'Step (advance to the next scheduled event)': 'Passo (avançar para o próximo evento)', 'Zoom In': 'Ampliar', 'Zoom Out': 'Reduzir',
  'Zoom to Full View': 'Ver Tudo', 'Go to Time 0': 'Ir para o Tempo 0', 'Go to Latest Time': 'Ir para o Último Tempo',
  'Previous Transition (selected signal)': 'Transição Anterior (sinal selecionado)', 'Next Transition (selected signal)': 'Transição Seguinte (sinal selecionado)',
  'Add Marker at Cursor': 'Adicionar Marcador no Cursor', 'Add Marker at cursor': 'Adicionar marcador no cursor', 'Add Marker Here': 'Adicionar Marcador Aqui',
  'Delete Marker': 'Apagar Marcador', 'Delete All Markers': 'Apagar Todos os Marcadores', 'Radix': 'Base', 'Radix of selected signals': 'Base dos sinais selecionados',
  'Default': 'Predefinida', 'Binary': 'Binário', 'Hexadecimal': 'Hexadecimal', 'Octal': 'Octal', 'Unsigned Decimal': 'Decimal sem Sinal',
  'Signed Decimal': 'Decimal com Sinal', 'Decimal': 'Decimal', 'Export waveform as VCD': 'Exportar formas de onda como VCD',
  'Add to Wave Window': 'Adicionar à Janela de Formas de Onda', 'Add to Wave Window (Recursive)': 'Adicionar à Janela de Formas de Onda (Recursivo)',
  'Show in wave window': 'Mostrar na janela de formas de onda', 'Force Constant...': 'Forçar Constante...', 'Force Clock...': 'Forçar Relógio...',
  'Remove Force': 'Remover Forçamento', 'Force Selected Signal': 'Forçar Sinal Selecionado', 'Define Clock': 'Definir Relógio', 'Signal Name:': 'Nome do Sinal:',
  'Force to Value:': 'Forçar para o Valor:', 'Value Radix:': 'Base do Valor:', 'Starting at Time Offset:': 'A partir do Tempo:',
  'Cancel after Time Offset:': 'Cancelar após o Tempo:', 'Leading Edge Value:': 'Valor do Flanco Inicial:', 'Trailing Edge Value:': 'Valor do Flanco Final:',
  'Period:': 'Período:', 'Duty Cycle (%):': 'Ciclo de Trabalho (%):', 'Apply': 'Aplicar', 'Expand Bus': 'Expandir Barramento', 'Collapse Bus': 'Recolher Barramento',
  'New Divider': 'Novo Divisor', 'Rename Divider...': 'Mudar Nome do Divisor...', 'Divider name:': 'Nome do divisor:', 'Delete': 'Apagar', 'Copy Path': 'Copiar Caminho',
  'Go To Source Code': 'Ir para o Código-Fonte', 'Type a command (help)': 'Escreva um comando (help)', 'Simulation run time': 'Tempo de simulação',
  'Time unit': 'Unidade de tempo', 'Zoom level': 'Nível de zoom', 'Select a signal in the wave window first': 'Selecione primeiro um sinal na janela de formas de onda',
  'No more transitions': 'Não há mais transições', 'No more events scheduled': 'Não há mais eventos agendados',
  'Specify the value to force the selected signal to.': 'Indique o valor a forçar no sinal selecionado.',
  'Specify the properties of the clock to be applied to the selected signal.': 'Indique as propriedades do relógio a aplicar ao sinal selecionado.',
  // schematic viewer
  'Zoom In (+)': 'Ampliar (+)', 'Zoom Out (−)': 'Reduzir (−)', 'Zoom to Full View (F)': 'Ver Tudo (F)', 'Up one level (Backspace)': 'Subir um nível (Backspace)',
  'Empty schematic — this unit has no ports, logic or instances.': 'Esquemático vazio — esta unidade não tem portos, lógica nem instâncias.',
  'Input port': 'Porto de entrada', 'Output port': 'Porto de saída', 'Bidirectional port': 'Porto bidirecional', 'Clocked process': 'Processo síncrono',
  'Combinational logic': 'Lógica combinatória', 'Testbench process': 'Processo de testbench', 'Black box (module not found)': 'Caixa negra (módulo não encontrado)',
  'Instance': 'Instância', 'Constant': 'Constante', 'Net (driven elsewhere)': 'Ligação (excitada noutro sítio)',
  // ASM editor
  'State': 'Estado', 'Decision': 'Decisão', 'Cond. output': 'Saída cond.', 'Arrange': 'Organizar', 'Fit': 'Ajustar', '✓ Validate': '✓ Validar',
  'Generate HDL': 'Gerar HDL', 'Add state box (rectangle)': 'Adicionar caixa de estado (retângulo)', 'Add decision box (diamond)': 'Adicionar caixa de decisão (losango)',
  'Add conditional output box (oval)': 'Adicionar caixa de saída condicional (oval)', 'Delete selection': 'Apagar seleção', 'Automatic top-down layout': 'Disposição automática de cima para baixo',
  'Toggle snapping to the grid': 'Ativar/desativar alinhamento à grelha', 'Fit the chart in the window': 'Ajustar o diagrama à janela',
  'Check the chart for errors': 'Verificar erros no diagrama', 'Generate the VHDL/Verilog file': 'Gerar o ficheiro VHDL/Verilog',
  'Show / hide the generated HDL preview': 'Mostrar / ocultar a pré-visualização do HDL gerado', 'Selection': 'Seleção', 'Machine': 'Máquina',
  'Module / entity name': 'Nome do módulo / entidade', 'HDL language': 'Linguagem HDL', 'State encoding': 'Codificação de estados', 'Clock': 'Relógio',
  'Reset': 'Reset', 'Reset level': 'Nível do reset', 'Reset type': 'Tipo de reset', 'Initial state': 'Estado inicial', 'Inputs': 'Entradas', 'Outputs': 'Saídas',
  'Width': 'Largura', 'Registered': 'Registada', 'Condition': 'Condição', 'Problems': 'Problemas', 'No problems found': 'Nenhum problema encontrado',
  'Moore outputs (one per line)': 'Saídas de Moore (uma por linha)', 'Mealy outputs (one per line)': 'Saídas de Mealy (uma por linha)',
  'Make this the initial (reset) state': 'Tornar este o estado inicial (reset)', 'Initial (reset) state': 'Estado inicial (reset)',
  'Exchange the true and false branches': 'Trocar os ramos verdadeiro e falso', 'Swap 1 / 0 exits': 'Trocar saídas 1 / 0', 'Delete box': 'Apagar caixa',
  'Delete connection': 'Apagar ligação', 'Reset route': 'Repor percurso', 'Use automatic routing': 'Usar encaminhamento automático',
  'State: name + Moore outputs': 'Estado: nome + saídas de Moore', 'Decision: condition, exits 1 / 0': 'Decisão: condição, saídas 1 / 0',
  'Conditional (Mealy) outputs': 'Saídas condicionais (Mealy)', 'Conditional output': 'Saída condicional', 'active high': 'ativo a alto', 'active low': 'ativo a baixo',
  'Gray': 'Gray', 'One-hot': 'One-hot', 'Enum / auto': 'Enum / automático', 'Code copied to clipboard': 'Código copiado',
  'Copy the code to the clipboard': 'Copiar o código', 'Cannot generate HDL: fix the errors listed in Problems': 'Não é possível gerar HDL: corrija os erros indicados em Problemas',
  'Default (combinational) or reset value (registered)': 'Valor por omissão (combinatória) ou de reset (registada)',
  'Drop the connection on a box (a state, decision or conditional output)': 'Largue a ligação numa caixa (estado, decisão ou saída condicional)',
  'Drag from a port ● to a box to connect · drag background to pan · wheel to zoom · Shift+drag to select · double-click to add a state': 'Arraste de um porto ● para uma caixa para ligar · arraste o fundo para deslocar · roda para zoom · Shift+arrastar para selecionar · duplo clique para adicionar um estado',
  // ASM editor: data path and every-cycle blocks
  'Every cycle': 'Cada ciclo', 'every clock cycle': 'em todos os ciclos de relógio', 'Every-cycle block': 'Bloco de cada ciclo',
  'Add an every-cycle block (logic evaluated on every clock cycle, in parallel with the states)': 'Adicionar um bloco de cada ciclo (lógica avaliada em todos os ciclos de relógio, em paralelo com os estados)',
  'Automatic layout (states top-down, every-cycle blocks on the right)': 'Disposição automática (estados de cima para baixo, blocos de cada ciclo à direita)',
  'Used in the generated code comments.': 'Usado nos comentários do código gerado.',
  'Actions on every cycle (one per line)': 'Ações em cada ciclo (uma por linha)',
  'e.g. tc = 0, cnt = cnt + 1. Assign registers, registered outputs (next value) or combinational outputs.': 'p.ex. tc = 0, cnt = cnt + 1. Atribua registos, saídas registadas (valor seguinte) ou saídas combinatórias.',
  'Connect the exit to decision and conditional output boxes: they are evaluated on every clock cycle, in parallel with the states. Leave the last exits unconnected (end of the block); paths may join again but must not loop or reach a state. An assignment of the current state to the same target takes priority.': 'Ligue a saída a caixas de decisão e de saída condicional: são avaliadas em todos os ciclos de relógio, em paralelo com os estados. Deixe as últimas saídas por ligar (fim do bloco); os caminhos podem voltar a juntar-se mas não podem formar ciclos nem chegar a um estado. Uma atribuição do estado atual ao mesmo destino tem prioridade.',
  'Every cycle: logic in parallel with the states': 'Cada ciclo: lógica em paralelo com os estados',
  'e.g. go, !done, cnt == 9, x && (mode == 2\'b01), (1 << n) > cnt. Exit 1 = true, 0 = false.': 'p.ex. go, !done, cnt == 9, x && (mode == 2\'b01), (1 << n) > cnt. Saída 1 = verdadeiro, 0 = falso.',
  'Sync': 'Sinc.', 'Synchronise with 2 flip-flops (conditions see the synchronised value)': 'Sincronizar com 2 flip-flops (as condições veem o valor sincronizado)',
  'Synchronise with 2 flip-flops (asynchronous input, e.g. a button)': 'Sincronizar com 2 flip-flops (entrada assíncrona, p.ex. um botão)',
  'Registers': 'Registos', 'Reset (initial) value': 'Valor de reset (inicial)', 'Reset value': 'Valor de reset', '+ register': '+ registo',
  'Add an internal register (data path)': 'Adicionar um registo interno (caminho de dados)', 'Generics': 'Genéricos',
  'Default value (integer)': 'Valor por omissão (inteiro)', 'Default value (non-negative integer)': 'Valor por omissão (inteiro não negativo)',
  '+ generic': '+ genérico', 'Add an integer generic / parameter': 'Adicionar um genérico / parâmetro inteiro', 'Remove': 'Remover',
  '+ input': '+ entrada', '+ output': '+ saída', 'Add an input port': 'Adicionar um porto de entrada', 'Add an output port': 'Adicionar um porto de saída',
  'Registers are internal: assign them like registered outputs (next value at the clock edge, they hold otherwise) and read them anywhere. Generics are integer VHDL generics / Verilog parameters, usable in expressions (e.g. cnt == N - 1).': 'Os registos são internos: atribua-os como as saídas registadas (valor seguinte no flanco do relógio, mantêm-se nos outros casos) e leia-os em qualquer lado. Os genéricos são generics VHDL / parameters Verilog inteiros, utilizáveis em expressões (p.ex. cnt == N - 1).',
  'Combinational outputs take their default unless assigned. Registered outputs (Reg) hold their value, reset to the default and can be read in conditions, e.g. cnt = cnt + 1.': 'As saídas combinatórias tomam o valor por omissão quando não atribuídas. As saídas registadas (Reg) mantêm o valor, fazem reset para o valor por omissão e podem ser lidas em condições, p.ex. cnt = cnt + 1.',
  // schematic symbol library: categories, decoders / encoders / demultiplexers
  'Logic': 'Lógica', 'Arithmetic': 'Aritmética', 'Flip-Flops': 'Flip-Flops', 'Mux': 'Multiplexadores', 'Decoders/Encoders': 'Descodificadores/Codificadores',
  'Bus': 'Barramento', 'Project modules': 'Módulos do projeto',
  'n:2^n binary decoder (one-hot outputs, all 0 when E = 0; like Xilinx D2_4E / D3_8E / D4_16E)': 'Descodificador binário n:2^n (saídas one-hot, todas a 0 quando E = 0; como os Xilinx D2_4E / D3_8E / D4_16E)',
  '2^n:n binary encoder: priority (highest active input wins) or one-hot (OR of the inputs); V = some input is 1': 'Codificador binário 2^n:n: com prioridade (ganha a entrada ativa de maior índice) ou one-hot (OU das entradas); V = alguma entrada a 1',
  '1:2^n demultiplexer: output O<S> = D, the other outputs 0 (bitwise when Width > 1)': 'Desmultiplexador 1:2^n: saída O<S> = D, as outras saídas a 0 (bit a bit quando Largura > 1)',
  'Address bits': 'Bits de endereço', 'Enable input E': 'Entrada de habilitação E', 'Bus pins (A, D)': 'Pinos em barramento (A, D)',
  'Output bits': 'Bits de saída', 'Bus pins (I, A)': 'Pinos em barramento (I, A)', 'Select bits': 'Bits de seleção', 'Type': 'Tipo',
  'priority': 'prioridade',
  // tri-state buffers (BUFE / BUFT)
  'Tri-State': 'Três estados', 'Enable input': 'Entrada de habilitação', 'One pin per bit (I0.., O0..)': 'Um pino por bit (I0.., O0..)',
  'Tri-state buffer: O = I while enabled, Z (high impedance, released) otherwise; E active high (BUFE) or T active low (BUFT)': 'Buffer de três estados: O = I enquanto habilitado, Z (alta impedância, libertado) caso contrário; E ativo a 1 (BUFE) ou T ativo a 0 (BUFT)',
  'Tri-state buffer, active-high enable: O = I when E = 1, Z when E = 0': 'Buffer de três estados, habilitação ativa a 1: O = I quando E = 1, Z quando E = 0',
  'Tri-state buffer, active-low enable T: O = I when T = 0, Z when T = 1': 'Buffer de três estados, habilitação T ativa a 0: O = I quando T = 0, Z quando T = 1',
  // Symbol Info (datasheets of the schematic symbols; their own texts are in core/symdocs.js)
  'Symbol Info (F1)': 'Informação do Símbolo (F1)', 'Symbol Info…': 'Informação do Símbolo…', 'Symbol Info': 'Informação do Símbolo',
  // schematic editor labels that were still in English
  'Select (Esc)': 'Selecionar (Esc)', 'Add Wire (W)': 'Adicionar Fio (W)', 'Add Net Name (N)': 'Adicionar Nome de Rede (N)', 'Add I/O Marker (O)': 'Adicionar Marcador de E/S (O)',
  'Rotate (Ctrl+R)': 'Rodar (Ctrl+R)', 'Mirror (Ctrl+M)': 'Espelhar (Ctrl+M)', 'Delete (Del)': 'Apagar (Del)', 'Keep connections': 'Manter ligações',
  'Undo (Ctrl+Z)': 'Anular (Ctrl+Z)', 'Redo (Ctrl+Y)': 'Refazer (Ctrl+Y)', 'Check': 'Verificar', 'View HDL': 'Ver HDL', 'Schematic sheet': 'Folha do esquemático',
  'Context clause': 'Cláusula de contexto', 'Compiler directives': 'Diretivas do compilador', 'one per line: NAME : type := default': 'uma por linha: NOME : tipo := valor por omissão',
  'signals, types, constants, functions emitted verbatim': 'sinais, tipos, constantes, funções copiados tal e qual',
  'Tip: drag symbols from the Symbols panel; double-click a module symbol to open its source.': 'Dica: arraste símbolos do painel Símbolos; faça duplo clique num símbolo de módulo para abrir a sua fonte.',
  'HDL kept with the schematic': 'HDL guardado com o esquemático',
  'More…': 'Mais…', 'Place Symbol': 'Colocar Símbolo', 'Datasheet of the symbol: pins, parameters, truth table, equivalent HDL': 'Folha de características do símbolo: pinos, parâmetros, tabela de verdade, HDL equivalente',
  // misc
  'Error': 'Erro', 'Warning': 'Aviso', 'Note': 'Nota', 'Failure': 'Falha', 'Running': 'Em curso', 'Running...': 'Em curso...', 'Other': 'Outro',
  'not available': 'indisponível', 'not found': 'não encontrado', 'see log': 'ver registo', 'Exported .xise': '.xise exportado',

  // modern interface (web/js/modern.js, web/js/palette.js): View ▸ Interface / Theme, header, design flow, command palette
  'Interface': 'Interface', 'Modern': 'Moderna', 'Xilinx ISE (Classic)': 'Xilinx ISE (Clássica)',
  'Theme': 'Tema', 'System': 'Sistema', 'Light': 'Claro', 'Dark': 'Escuro', 'Command Palette…': 'Paleta de Comandos…',
  'Implement': 'Implementar', 'Emulate': 'Emular', 'Design flow': 'Fluxo de projeto',
  'Check Syntax of the selected module': 'Verificar a sintaxe do módulo selecionado',
  'Simulate Behavioral Model of the selected module': 'Simular o modelo comportamental do módulo selecionado',
  'No project open': 'Nenhum projeto aberto', 'Main menu': 'Menu principal', 'Panels': 'Painéis',
  'Search commands and files (Ctrl+K)': 'Procurar comandos e ficheiros (Ctrl+K)', 'Search commands and files…': 'Procurar comandos e ficheiros…',
  'Search commands and files': 'Procurar comandos e ficheiros', 'Switch between light and dark theme': 'Alternar entre tema claro e escuro',
  'Open a source from the Design panel, or search for any command or file.': 'Abra uma fonte no painel Projeto, ou procure qualquer comando ou ficheiro.',
  'No matching commands or files': 'Nenhum comando ou ficheiro corresponde', 'to navigate': 'para navegar', 'to run': 'para executar', 'to close': 'para fechar',
  'Clear Recent Projects': 'Limpar Projetos Recentes', 'Recent projects cleared (the projects themselves are kept)': 'Projetos recentes limpos (os projetos mantêm-se)',
  'Power switch: click to turn the board off / on': 'Interruptor de alimentação: clique para desligar / ligar a placa', 'Power off': 'Desligada', 'Power': 'Alimentação',
  'Open file': 'Abrir ficheiro', 'Command palette': 'Paleta de comandos', 'Command palette: search commands and files': 'Paleta de comandos: procurar comandos e ficheiros',
};

const PT_GATE_INV = { 'input I0': 'a entrada I0', 'inputs I0 and I1': 'as entradas I0 e I1' };
const PT_FF = [['synchronous set and reset (S over R)', 'set e reset síncronos (S antes de R)'], ['synchronous reset and set (R over S)', 'reset e set síncronos (R antes de S)'],
  ['clock enable', 'habilitação do relógio'], ['asynchronous clear', 'clear assíncrono'], ['asynchronous preset', 'preset assíncrono'],
  ['synchronous reset', 'reset síncrono'], ['synchronous set', 'set síncrono']];
const PT_PATTERNS = [
  // schematic symbols: flip-flops (FD*, FT*, FJK*)
  [/^(D|Toggle \(T\)|J-K) flip-flop(?: with (.*))?$/, (m, k, w) => {
    let r = w || '';
    for (const [a, b] of PT_FF) r = r.split(a).join(b);
    return `Flip-flop ${k === 'Toggle (T)' ? 'T (toggle)' : k}${w ? ` com ${r.replace(/ and /g, ' e ')}` : ''}`;
  }],
  // schematic symbols: inverted-input gates (AND2B1...), decoders, encoders, demultiplexers
  [/^(\d)-input (AND|OR|NAND|NOR) gate with (input I0|inputs I0 and I1|inputs I0\.\.I\d) inverted \(bitwise when Width > 1\)$/,
    (m, n, g, which) => `Porta ${g} de ${n} entradas com ${PT_GATE_INV[which] || `as entradas ${which.slice(7)}`} invertida${which === 'input I0' ? '' : 's'} (bit a bit quando Largura > 1)`],
  [/^(\d+):(\d+) decoder with enable \(Xilinx (\w+)\): D<A> = E, the other outputs 0$/, 'Descodificador $1:$2 com habilitação (Xilinx $3): D<A> = E, as outras saídas a 0'],
  [/^(\d+):(\d+) priority encoder: A = index of the highest input at 1 \(0 when none\), V = some input is 1$/, 'Codificador com prioridade $1:$2: A = índice da entrada a 1 de maior índice (0 se nenhuma), V = alguma entrada a 1'],
  [/^(\d+):(\d+) one-hot encoder: A = OR of the indices of the inputs at 1, V = some input is 1$/, 'Codificador one-hot $1:$2: A = OU dos índices das entradas a 1, V = alguma entrada a 1'],
  [/^1:(\d+) demultiplexer \((select S0|(\d)-bit select S)\): O<S> = D, the other outputs 0 \(bitwise when Width > 1\)$/,
    (m, n, sel, k) => `Desmultiplexador 1:${n} (${k ? `seleção S de ${k} bits` : 'seleção S0'}): O<S> = D, as outras saídas a 0 (bit a bit quando Largura > 1)`],
  [/^(\d+)-bit tri-state buffer \((pins I0\.\.I3, O0\.\.O3|bus pins)\), active-(high|low) enable( T)?: O = I when (E = 1|T = 0), Z when (E = 0|T = 1)$/,
    (m, n, pins, hl, tt, on, off) => `Buffer de três estados de ${n} bits (${pins === 'bus pins' ? 'pinos em barramento' : 'pinos I0..I3, O0..O3'}), habilitação${tt || ''} ativa a ${hl === 'high' ? '1' : '0'}: O = I quando ${on}, Z quando ${off}`],
  [/^(Logic|Tri-State|Arithmetic|Flip-Flops|Mux|Decoders\/Encoders|Bus|I\/O|Project modules) \((\d+)\)$/, (m, c, n) => `${t(c)} (${n})`],
  [/^Silinx - (.*) - \[(.*)\]$/, (m, a, b) => `Silinx - ${a} - [${t(b)}]`],
  [/^(.*) \(RTL\)$/, '$1 (RTL)'],
  [/^Processes: (.*)$/, 'Processos: $1'],
  [/^HDL kept with the schematic \((VHDL|VERILOG)\)$/, 'HDL guardado com o esquemático ($1)'],
  [/^Language: (.*)$/, 'Idioma: $1'],
  [/^(\d+)\/(\d+) I\/Os assigned$/, '$1/$2 E/S atribuídas'],
  [/^Top: (.*?) · Device (.*?) · Board: (.*)$/, 'Topo: $1 · Dispositivo $2 · Placa: $3'],
  [/^Top: (.*?) · Device (.*?) · no board selected$/, 'Topo: $1 · Dispositivo $2 · sem placa selecionada'],
  [/^(.*) Project Status$/, 'Estado do Projeto $1'],
  [/^Configuration file: (.*)$/, 'Ficheiro de configuração: $1'],
  [/^Bitstream: design (.*)$/, 'Bitstream: projeto $1'],
  [/^(\d+) Errors$/, '$1 Erros'], [/^(\d+) Warnings$/, '$1 Avisos'], [/^(\d+) HDL files$/, '$1 ficheiros HDL'],
  [/^position (\d+)$/, 'posição $1'],
  [/^(\d+) file\(s\) selected$/, '$1 ficheiro(s) selecionado(s)'],
  [/^Folder '(.*)': (\d+) file\(s\), project (.*)$/, "Pasta '$1': $2 ficheiro(s), projeto $3"],
  [/^Number of (.+)$/, 'Número de $1'],
  [/^Balanced \((Speed|Area)\)$/, (m, g) => `Equilibrado (${g === 'Speed' ? 'Velocidade' : 'Área'})`],
  [/^Example: (.*)$/, 'Exemplo: $1'],
  [/^Settings file: (.*)$/, 'Ficheiro de definições: $1'],
  [/^Version (\d[\w.-]*)$/, 'Versão $1'],
  // schematic palette: "<SYMBOL>: <description>"
  [/^([A-Z][A-Z0-9_]*(?: [A-Z]+)?): (.+)$/, (m, a, b) => `${a}: ${t(b)}`],
];

// t() looks strings up trimmed: the keys are trimmed the same way
for (const k of Object.keys(PT)) { const tk = k.trim(); if (tk !== k) { if (!(tk in PT)) PT[tk] = PT[k].trim(); delete PT[k]; } }
Object.assign(PT, {
  'Not in sync with': 'Não sincronizado com', '— editing here updates the schematic': '— editar aqui atualiza o esquemático',
  '— editing here updates the state machine': '— editar aqui atualiza a máquina de estados',
  '(schematic view of this file) — editing here updates it': '(vista em esquemático deste ficheiro) — editar aqui atualiza-a',
  '(state machine view of this file) — editing here updates it': '(vista em máquina de estados deste ficheiro) — editar aqui atualiza-a',
  // Design Summary, File menu, project / import dialogs, toolchain, About, shortcuts
  'Device Utilization Summary (not yet implemented)': 'Resumo da Utilização do Dispositivo (ainda não implementado)',
  'Tip: double-click a process in the Processes panel to run it. Simulation runs entirely inside Silinx; synthesis/implementation require Xilinx ISE 14.7 (Tools ▸ Toolchain Settings).':
    'Dica: faça duplo clique num processo no painel Processos para o executar. A simulação corre inteiramente no Silinx; a síntese/implementação requer o Xilinx ISE 14.7 (Ferramentas ▸ Definições da Toolchain).',
  'Print…': 'Imprimir…', 'project name': 'nome do projeto', 'new project name': 'nome do novo projeto', 'file name': 'nome do ficheiro',
  'Device': 'Dispositivo', 'Top': 'Topo', 'Board': 'Placa', '.zip file:': 'Ficheiro .zip:',
  'Import a whole Silinx project from a .zip made with File ▸ Export Silinx ISE Project (silinx.json and every project file: sources, ASM charts, schematics, constraints, simulation files).':
    'Importe um projeto Silinx completo a partir de um .zip feito com Ficheiro ▸ Exportar Projeto Silinx ISE (silinx.json e todos os ficheiros do projeto: fontes, diagramas ASM, esquemáticos, restrições, ficheiros de simulação).',
  'Easiest setup on any OS:': 'Configuração mais simples em qualquer sistema operativo:',
  'build the private Docker image with the Silinx kit (docker/ise/README.md):': 'construa a imagem Docker privada com o kit do Silinx (docker/ise/README.md):',
  '(Windows: build-ise-image.ps1). It configures Silinx automatically.': '(Windows: build-ise-image.ps1). Configura o Silinx automaticamente.',
  'auto-detect (…/14.7/ISE_DS/settings64.sh)': 'deteção automática (…/14.7/ISE_DS/settings64.sh)',
  'Synthesis, place & route and bitstream generation use the Xilinx ISE 14.7 command-line tools. Xilinx, ISE, ISim, iMPACT and Spartan are trademarks of AMD/Xilinx; Silinx ISE is an independent project, not affiliated with or endorsed by AMD/Xilinx.':
    'A síntese, o place & route e a geração do bitstream usam as ferramentas de linha de comandos do Xilinx ISE 14.7. Xilinx, ISE, ISim, iMPACT e Spartan são marcas registadas da AMD/Xilinx; o Silinx ISE é um projeto independente, sem afiliação nem aprovação da AMD/Xilinx.',
  'F12 or Ctrl/Cmd+Click': 'F12 ou Ctrl/Cmd+Clique',
  // board emulator
  'Max speed': 'Velocidade máxima', '▶ Run': '▶ Executar', '⏸ Pause': '⏸ Pausa', '⏭ Step': '⏭ Passo', '⟲ Power cycle': '⟲ Desligar/ligar',
  'Advance one clock cycle': 'Avançar um ciclo de relógio', 'Power-cycle the board: restart the design from time 0': 'Desligar e ligar a placa: reiniciar o projeto a partir do instante 0',
  'Emulated clock rate': 'Frequência do relógio emulado', 'Model:': 'Modelo:', 'Clock:': 'Relógio:', 'Timing:': 'Temporização:',
  'What runs on the board: the HDL (RTL) or a netlist generated by ISE (netgen)': 'O que corre na placa: o HDL (RTL) ou uma netlist gerada pelo ISE (netgen)',
  'Behavioral (RTL)': 'Comportamental (RTL)',
  'Character LCD (HD44780): lcd_e, lcd_rs, lcd_rw, lcd_d': 'LCD de caracteres (HD44780): lcd_e, lcd_rs, lcd_rw, lcd_d', 'LCD: not connected in the UCF': 'LCD: não ligado no UCF',
  'Turn the knob: ⟲ / ⟳ or the mouse wheel (ROT_A / ROT_B)': 'Rode o botão: ⟲ / ⟳ ou a roda do rato (ROT_A / ROT_B)',
  'Rotary encoder: ROT_A / ROT_B not connected in the UCF': 'Codificador rotativo: ROT_A / ROT_B não ligados no UCF',
  'Turn left (counter-clockwise)': 'Rodar para a esquerda (sentido anti-horário)', 'Turn right (clockwise)': 'Rodar para a direita (sentido horário)',
  'Watch': 'Observar', 'Add a signal to watch…': 'Adicionar um sinal a observar…', 'Timing generics': 'Genéricos de temporização',
  'Not on the board': 'Fora da placa', 'Messages': 'Mensagens', 'No clock input found': 'Nenhuma entrada de relógio encontrada',
  'Divided so that counters, dividers and debouncers advance at the emulator\'s speed (about 10^5 clock cycles per second instead of 50 MHz). The design and the bitstream are not changed.':
    'Divididos para que contadores, divisores e debouncers avancem à velocidade do emulador (cerca de 10^5 ciclos de relógio por segundo em vez de 50 MHz). O projeto e o bitstream não são alterados.',
  'Real values: at the emulator\'s speed, a design that counts millions of cycles moves very slowly.': 'Valores reais: à velocidade do emulador, um projeto que conta milhões de ciclos avança muito devagar.',
  'The design is simulated from its HDL (behavioural RTL) at a reduced clock rate; registers without an initial value start at 0, as on the FPGA; each display digit keeps the last pattern it showed between its refreshes, as your eye does on the real board. Buttons: press and hold; Shift+click keeps a button pressed.':
    'O projeto é simulado a partir do seu HDL (RTL comportamental) com um relógio mais lento; os registos sem valor inicial começam a 0, como na FPGA; cada dígito do mostrador mantém o último padrão entre atualizações, como o olho faz na placa real. Botões: carregue e mantenha; Shift+clique mantém um botão carregado.',
  // ASM chart editor
  'Value(s) of this exit: binary digits, a literal, a|b, or others': 'Valor(es) desta saída: dígitos binários, um literal, a|b, ou others',
  'Registered output (holds its value, readable in conditions)': 'Saída registada (mantém o valor, pode ser lida em condições)',
  'Value(s) of this exit': 'Valor(es) desta saída', 'Value tested': 'Valor testado', 'Exits (value → box)': 'Saídas (valor → caixa)', 'Connection': 'Ligação', 'Case': 'Case',
  // schematic editor
  'HDL language for Generate / View HDL': 'Linguagem HDL para Gerar / Ver HDL',
  'Moving components: keep the wires connected (re-routed around other parts) or detach them': 'Ao mover componentes: manter os fios ligados (reencaminhados à volta das outras peças) ou desligá-los',
  'Check Schematic': 'Verificar Esquemático', 'View generated HDL': 'Ver o HDL gerado', 'Generate HDL source from the schematic': 'Gerar a fonte HDL a partir do esquemático',
  'Module name': 'Nome do módulo', 'Sheet size': 'Tamanho da folha', 'Declarations': 'Declarações', 'Architecture name': 'Nome da arquitetura',
  'Instance name': 'Nome da instância', 'Module': 'Módulo', 'Title': 'Título', 'Input pins': 'Pinos de entrada', 'Output pins': 'Pinos de saída',
  'HDL type': 'Tipo HDL', 'Draw as bus': 'Desenhar como barramento', 'Rename net': 'Mudar o nome da rede',
  // print dialog
  'Paper': 'Papel', 'Orientation': 'Orientação', 'Pages across': 'Páginas na horizontal', 'PNG resolution': 'Resolução PNG', 'Automatic': 'Automática',
  'Landscape': 'Horizontal', 'Portrait': 'Vertical', '1× (screen size)': '1× (tamanho do ecrã)', 'Save PNG': 'Guardar PNG', 'Save SVG': 'Guardar SVG',
  // placeholders
  'name': 'nome', 'Search symbols…': 'Procurar símbolos…', 'net name': 'nome da rede', 'auto': 'automático', 'e.g. my-ise:14.7': 'p.ex. my-ise:14.7',
});
const PT_POST = { 'Post-Synthesis': 'Pós-Síntese', 'Post-Translate': 'Pós-Translate', 'Post-Map': 'Pós-Map', 'Post-Place & Route': 'Pós-Place & Route' };
const PT_PRESS = { ' — click to toggle': ' — clique para comutar', ' — press and hold (Shift+click keeps it pressed)': ' — carregue e mantenha (Shift+clique mantém-no carregado)' };
PT_PATTERNS.unshift(
  // board emulator
  [/^Divide the timing generics \((.*)\) so that the design runs visibly at the emulator's speed$/, 'Dividir os genéricos de temporização ($1) para que o projeto avance visivelmente à velocidade do emulador'],
  [/^(Post-Synthesis|Post-Translate|Post-Map|Post-Place & Route) netlist( \(not generated\))?$/, (m, n, ng) => `Netlist ${PT_POST[n]}${ng ? ' (não gerada)' : ''}`],
  [/^(.+) = (.+) \(pin (\w+)\)( — click to toggle| — press and hold \(Shift\+click keeps it pressed\))?$/, (m, r, b, p, s) => `${r} = ${b} (pino ${p})${s ? PT_PRESS[s] : ''}`],
  [/^(.+): not connected in the UCF( — click to toggle| — press and hold \(Shift\+click keeps it pressed\))?$/, (m, r, s) => `${r}: não ligado no UCF${s ? PT_PRESS[s] : ''}`],
  [/^Clock (.+): ([\d.]+) MHz on the board( \(not in the UCF: assumed\))?( · not emulated: (.*))?$/, (m, c, f, a, n, l) => `Relógio ${c}: ${f} MHz na placa${a ? ' (não está no UCF: assumido)' : ''}${n ? ` · não emulado: ${l}` : ''}`],
  [/^No clock input found · not emulated: (.*)$/, 'Nenhuma entrada de relógio encontrada · não emulado: $1'],
  [/^Timing ÷(.+) \(emulation only\)$/, 'Temporização ÷$1 (só na emulação)'],
  [/^t = (.+?) · ([\d,.\s]+) cycles(.*)$/, (m, tm, n, rest) => `t = ${tm} · ${n} ciclos${rest.replace('% of real time)', '% do tempo real)').replace(' · stopped by an error', ' · parado por um erro')}`],
  [/^(\d+) port bit\(s\) have no LOC on a (.+) resource \(inputs are held at 0\):$/, '$1 bit(s) de porto sem LOC num recurso da $2 (as entradas ficam a 0):'],
  // print dialog
  [/^Print — (.*)$/, 'Imprimir — $1'],
  [/^(\d+) pages? \((\d+) across × (\d+) down\), (\S+) (landscape|portrait); 12 px text prints at ([\d.]+) pt$/,
    (m, n, c, r, p, o, pt) => `${n} página${n === '1' ? '' : 's'} (${c} na horizontal × ${r} na vertical), ${p} ${o === 'landscape' ? 'horizontal' : 'vertical'}; texto de 12 px impresso a ${pt} pt`],
  [/^Drawing: (\d+) × (\d+) px\. Large diagrams: several pages across \(tiles\) or A3; text below ~5 pt is hard to read on paper\. For a PDF choose "Save as PDF" in the print dialog \(keep the margins at "Default"\)\.$/,
    'Desenho: $1 × $2 px. Diagramas grandes: várias páginas na horizontal (mosaico) ou A3; texto abaixo de ~5 pt é difícil de ler em papel. Para um PDF escolha "Guardar como PDF" no diálogo de impressão (mantenha as margens em "Predefinição").'],
);

// live schematic simulation (sch-live.js)
Object.assign(PT, {
  'Simulate': 'Simular', 'Simulate: click the inputs and watch the circuit work (Esc to stop)': 'Simular: clique nas entradas e veja o circuito a funcionar (Esc para parar)',
  'Live simulation: click the inputs (switches, bus values, clocks), hover a wire or pin to see its value, drag to pan. Esc stops the simulation.':
    'Simulação em tempo real: clique nas entradas (interruptores, valores de barramentos, relógios), passe o rato sobre um fio ou pino para ver o valor, arraste para deslocar. Esc para a simulação.',
  'Building the simulation model…': 'A construir o modelo de simulação…', 'Live simulation': 'Simulação em tempo real',
  'Power cycle: back to time 0, registers to their initial values': 'Religar: volta ao tempo 0, registos com os valores iniciais',
  'Step': 'Passo', 'One clock cycle (rising and falling edge)': 'Um ciclo de relógio (flanco ascendente e descendente)', 'Pause': 'Pausa',
  'Run / pause the clock': 'Executar / pausar o relógio', 'Clock rate': 'Frequência do relógio', 'Buses:': 'Barramentos:',
  'Number format of the bus values': 'Formato dos valores dos barramentos', 'Stop Simulation': 'Parar Simulação',
  'Leave the simulation and edit the schematic (Esc)': 'Sair da simulação e editar o esquemático (Esc)', 'Number format': 'Formato do número',
  'Subtract 1': 'Subtrair 1', 'Add 1': 'Somar 1', 'All bits 0': 'Todos os bits a 0', 'Set': 'Aplicar',
  'Hex 0x1F, binary 0b101, or decimal; ↑ / ↓ add / subtract 1': 'Hex 0x1F, binário 0b101 ou decimal; ↑ / ↓ somam / subtraem 1',
  'Click an input to change it: 1-bit inputs toggle, buses open a value editor, clock inputs step one cycle. Wires: green = 1, dark green = 0, red = X/U, blue = Z. Hover a pin or a wire to see its value; click a component to list its pins.':
    'Clique numa entrada para a mudar: as entradas de 1 bit comutam, os barramentos abrem um editor de valor, as entradas de relógio avançam um ciclo. Fios: verde = 1, verde escuro = 0, vermelho = X/U, azul = Z. Passe o rato sobre um pino ou fio para ver o valor; clique num componente para listar os seus pinos.',
  'click for one clock cycle': 'clique para um ciclo de relógio', 'click to toggle': 'clique para comutar', 'click to change the value': 'clique para mudar o valor',
  'no value': 'sem valor', '(unconnected)': '(não ligado)',
});
PT_PATTERNS.push(
  [/^Cannot simulate: (.*)$/s, 'Não é possível simular: $1'],
  [/^Simulation refused: (\d+) error\(s\), (\d+) warning\(s\)$/, 'Simulação recusada: $1 erro(s), $2 aviso(s)'],
  [/^Simulation stopped: (.*)$/s, 'Simulação parada: $1'],
);
// New Source types, Module Wizard and Schematic Wizard (web/js/modwizard.js, core/modgen.js)
Object.assign(PT, {
  'Module (HDL)': 'Módulo (HDL)', 'Module (Wizard)': 'Módulo (Assistente)', 'Schematic (Diagram)': 'Esquemático (Diagrama)', 'Schematic (Wizard)': 'Esquemático (Assistente)',
  'Module Wizard': 'Assistente de Módulo', 'Schematic Wizard': 'Assistente de Esquemático',
  'Name and Language': 'Nome e Linguagem', 'Inputs and Outputs': 'Entradas e Saídas', 'Kind of Logic': 'Tipo de Lógica',
  'The wizard creates a schematic with an I/O marker for each input and output, ready for you to place the symbols and wire them.':
    'O assistente cria um esquemático com um marcador de E/S para cada entrada e saída, pronto para colocar os símbolos e ligá-los.',
  'The wizard writes a commented skeleton of the module: its inputs and outputs, and a template of the logic (combinational or sequential).':
    'O assistente escreve um esqueleto comentado do módulo: as entradas e saídas, e um modelo da lógica (combinatória ou sequencial).',
  'Schematic (module) name:': 'Nome do esquemático (módulo):', 'Module name:': 'Nome do módulo:', 'Description (optional):': 'Descrição (opcional):',
  'What the module does (it goes into the header comment)': 'O que o módulo faz (vai para o comentário de cabeçalho)',
  'Quick add (inputs):': 'Adicionar (entradas):', 'Quick add (outputs):': 'Adicionar (saídas):', 'Width (bits)': 'Largura (bits)',
  '1 = a single bit; N = a bus of N bits (N-1 downto 0)': '1 = um só bit; N = um barramento de N bits (N-1 downto 0)',
  'Description': 'Descrição', 'output': 'saída', 'optional': 'opcional', 'Add Port': 'Adicionar Porto',
  'No ports yet: use the quick-add buttons or Add Port.': 'Ainda sem portos: use os botões de adição rápida ou Adicionar Porto.',
  'One assignment per output (concurrent)': 'Uma atribuição por saída (concorrente)', 'One process / always block that reads every input': 'Um processo / bloco always que lê todas as entradas',
  'No reset': 'Sem reset', 'Synchronous (at the clock edge)': 'Síncrono (no flanco do relógio)', 'Asynchronous (at once)': 'Assíncrono (imediato)',
  "Active high ('1')": "Ativo a 1 ('1')", "Active low ('0')": "Ativo a 0 ('0')",
  'Style:': 'Estilo:', 'Reset:': 'Tipo de reset:', 'Reset input:': 'Entrada de reset:', 'Enable input:': 'Entrada de habilitação:',
  'Combinational: the outputs depend only on the present inputs (gates, multiplexers, adders, decoders…). Every output gets a default value, so no latch is made.':
    'Combinatória: as saídas dependem só das entradas atuais (portas, multiplexadores, somadores, descodificadores…). Cada saída recebe um valor por omissão, por isso não se cria nenhuma latch.',
  'Sequential: the outputs are registers that change at the rising edge of the clock (counters, shift registers, state machines…). The reset sets them to 0.':
    'Sequencial: as saídas são registos que mudam no flanco ascendente do relógio (contadores, registos de deslocamento, máquinas de estados…). O reset põe-nos a 0.',
  'Combinational': 'Combinatória', 'Sequential (clocked)': 'Sequencial (com relógio)', 'Default value': 'Valor por omissão',
  'Generics (optional)': 'Genéricos (opcional)', 'Add Generic': 'Adicionar Genérico',
  'Constants given when the module is used, e.g. a width (VHDL generic, Verilog parameter).': 'Constantes dadas quando o módulo é usado, p. ex. uma largura (generic em VHDL, parameter em Verilog).',
  'Preview of the code:': 'Pré-visualização do código:', 'Clock input:': 'Entrada de relógio:',
  'shown on the sheet and as a comment in the HDL': 'mostrada na folha e como comentário no HDL',
  'Add at least one input or output.': 'Adicione pelo menos uma entrada ou saída.',
  'A sequential module needs a clock: add a 1-bit input (e.g. clk) on the previous page.': 'Um módulo sequencial precisa de um relógio: adicione uma entrada de 1 bit (p. ex. clk) na página anterior.',
  'Choose the reset input, or No reset.': 'Escolha a entrada de reset, ou Sem reset.',
  'The clock and the reset must be different inputs.': 'O relógio e o reset têm de ser entradas diferentes.',
  'The enable must be an input other than the clock and the reset.': 'A habilitação tem de ser uma entrada diferente do relógio e do reset.',
  'A sequential module needs a clock: a 1-bit input.': 'Um módulo sequencial precisa de um relógio: uma entrada de 1 bit.',
  'The reset must be a 1-bit input other than the clock.': 'O reset tem de ser uma entrada de 1 bit diferente do relógio.',
  'The enable must be a 1-bit input other than the clock and the reset.': 'A habilitação tem de ser uma entrada de 1 bit diferente do relógio e do reset.',
});
// identifier problems (core/modgen.js identError), inside the messages below
const ptIdent = s => s
  .replace(/^the name is empty$/, 'o nome está vazio')
  .replace(/^('.*') must start with a letter$/, '$1 tem de começar por uma letra')
  .replace(/^('.*') may only contain letters, digits and _$/, '$1 só pode ter letras, dígitos e _')
  .replace(/^('.*'): no double __ and no _ at the end$/, '$1: sem __ seguidos e sem _ no fim')
  .replace(/^('.*') is a reserved word of (VHDL|Verilog)$/, '$1 é uma palavra reservada de $2');
PT_PATTERNS.push(
  [/^(Name|Module name|Architecture name|Generic|Port (\d+)): (.*)\.$/, (m, w, k, e) => `${{ Name: 'Nome', 'Module name': 'Nome do módulo', 'Architecture name': 'Nome da arquitetura', Generic: 'Genérico' }[w] || `Porto ${k}`}: ${ptIdent(e)}.`],
  [/^Port '(.*)' has the name of the module\.$/, "O porto '$1' tem o nome do módulo."],
  [/^Two ports are named '([^']*)'\.$/, "Há dois portos com o nome '$1'."],
  [/^Two ports are named '([^']*)' \(letter case does not count: '([^']*)'\)\.$/, "Há dois portos com o nome '$1' (maiúsculas e minúsculas não contam: '$2')."],
  [/^Port '(.*)': the width must be a whole number from 1 to (\d+)\.$/, "Porto '$1': a largura tem de ser um número inteiro de 1 a $2."],
  [/^The generic '(.*)' has the name of a port or of another generic\.$/, "O genérico '$1' tem o nome de um porto ou de outro genérico."],
  [/^The generic '(.*)' has the name of a port or of the module\.$/, "O genérico '$1' tem o nome de um porto ou do módulo."],
  [/^Generic '(.*)': the default value must be a whole number\.$/, "Genérico '$1': o valor por omissão tem de ser um número inteiro."],
  [/^A module named '(.*)' already exists\.$/, "Já existe um módulo chamado '$1'."],
  [/^(\S+) already exists\.$/, '$1 já existe.'],
  [/^Open-source components \((\d+)\)$/, 'Componentes de código aberto ($1)'],
  [/^Copyright 2026 Pedro Maló\. Free software under the GNU Affero General Public License v3\.0 \($/, 'Copyright 2026 Pedro Maló. Software livre sob a GNU Affero General Public License v3.0 ('],

  [/^Removed (\S+) from the project$/, 'Removido $1 do projeto'],
  [/^The project starts with (\S+) \(the top module 'top'\), synchronized with its HDL module\.$/, "O projeto começa com $1 (o módulo de topo 'top'), sincronizado com o seu módulo HDL."],
  [/^(\S+) already exists\.\n\nReplace it\? Its current contents will be lost\.$/, '$1 já existe.\n\nSubstituir? O conteúdo atual perde-se.'],
  [/^(\S+) already exists: choose another name\.$/, '$1 já existe: escolha outro nome.'],
);
Object.assign(PT, TT_PT); PT_PATTERNS.unshift(...TT_PT_PATTERNS);   // Truth Table / Karnaugh Map tool
Object.assign(PT, IO_PT); PT_PATTERNS.unshift(...IO_PT_PATTERNS);   // bidirectional (inout) ports of the wizards
Object.assign(PT, LINT_PT);   // design checks (the help texts of the messages are in core/hints.js)
for (const [k, v] of Object.entries(FSM_PT)) if (!(k in PT)) PT[k] = v;   // FSM state diagram editor (existing translations kept)
PT_PATTERNS.unshift(...FSM_PT_PATTERNS);
for (const [k, v] of Object.entries(FPGA_PT)) if (!(k in PT)) PT[k] = v;   // View Implemented Design (FPGA)
PT_PATTERNS.unshift(...FPGA_PT_PATTERNS);

export const LOCALES = {
  en: { name: 'English', strings: {}, patterns: [] },
  pt: { name: 'Português', strings: PT, patterns: PT_PATTERNS },
};

const KEY = 'silinx.lang';
let lang = 'en';
try { lang = localStorage.getItem(KEY) || ''; } catch { /* storage unavailable */ }
if (!LOCALES[lang]) lang = /^pt\b/i.test(navigator.language || '') ? 'pt' : 'en';

export const getLanguage = () => lang;

/** Translate an English UI string (exact match or pattern) into the current language. */
export function t(text) {
  if (lang === 'en' || text == null) return text;
  const L = LOCALES[lang];
  const s = String(text);
  const key = s.trim();
  if (!key) return s;
  let out = L.strings[key];
  if (out === undefined) {
    for (const [re, rep] of L.patterns) if (re.test(key)) { out = key.replace(re, rep); break; }   // rep: string or function
  }
  if (out === undefined) return s;
  return s.replace(key, out);    // keep surrounding whitespace
}

// ---------------------------------------------------------------- DOM translation
const SKIP = '.CodeMirror, .console-page, pre, code, textarea, [data-no-i18n], #hier .lbl, #libs-page .lbl, svg text, .sch-svg, .xl-hover-tip, .CodeMirror-hints';
const ATTRS = ['title', 'placeholder', 'aria-label'];
const textState = new WeakMap();   // text node -> { orig, last }
const attrState = new WeakMap();   // element -> { [attr]: { orig, last } }

function skipEl(el) { return !el || (el.closest && el.closest(SKIP)); }

function translateText(node) {
  const parent = node.parentElement;
  if (!parent || skipEl(parent) || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return;
  const cur = node.nodeValue;
  let st = textState.get(node);
  if (!st || cur !== st.last) { st = { orig: cur, last: cur }; textState.set(node, st); }
  const next = t(st.orig);
  if (next !== cur) { st.last = next; node.nodeValue = next; } else st.last = cur;
}

function translateAttrs(el) {
  if (skipEl(el)) return;
  let map = attrState.get(el);
  for (const a of ATTRS) {
    if (!el.hasAttribute(a)) continue;
    const cur = el.getAttribute(a);
    if (!map) { map = {}; attrState.set(el, map); }
    let st = map[a];
    if (!st || cur !== st.last) st = map[a] = { orig: cur, last: cur };
    const next = t(st.orig);
    if (next !== cur) { st.last = next; el.setAttribute(a, next); }
  }
}

export function translateTree(root) {
  if (!root) return;
  if (root.nodeType === 3) { translateText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
  if (root.nodeType === 1) { if (skipEl(root)) return; translateAttrs(root); }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: n => (n.nodeType === 1 && n.matches?.(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) translateText(n); else translateAttrs(n);
  }
}

let observer = null;
let docTitle = { orig: null, last: null };
function translateTitle() {
  if (document.title !== docTitle.last) docTitle.orig = document.title;
  docTitle.last = t(docTitle.orig);
  if (document.title !== docTitle.last) document.title = docTitle.last;
}

export function startI18n() {
  document.documentElement.lang = lang;
  translateTree(document.body);
  translateTitle();
  if (observer) return;
  observer = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(n => translateTree(n));
      else if (m.type === 'characterData') translateText(m.target);
      else if (m.type === 'attributes' && ATTRS.includes(m.attributeName)) translateAttrs(m.target);
    }
    translateTitle();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}

// views that render their own texts per language (e.g. the Symbol Info datasheets) re-render on a change
const langListeners = new Set();
/** Call fn(lang) after every language change; returns the function that removes the listener. */
export function onLanguageChange(fn) { langListeners.add(fn); return () => langListeners.delete(fn); }

export function setLanguage(next) {
  if (!LOCALES[next] || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  document.documentElement.lang = lang;
  translateTree(document.body);     // re-translate from the stored English originals
  translateTitle();
  for (const fn of [...langListeners]) { try { fn(lang); } catch (e) { console.error(e); } }
}
