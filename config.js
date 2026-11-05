/*
 * CONFIGURAÇÃO DO OUVIR JUNTOS
 *
 * MQTT_BROKERS: lista de servidores de mensagens (wss://...) usados pelas salas e para enviar os mp3.
 *   null = padrão (EMQX, HiveMQ e Mosquitto públicos). A ORDEM define a letra do código da sala;
 *   não reordene depois de divulgar convites. Para mais estabilidade, use um servidor MQTT seu
 *   (ex.: EMQX Cloud, HiveMQ Cloud) e aceite mensagens de pelo menos 64 KB.
 * FILE_RATE_KBPS: velocidade máxima de envio do mp3 pela sala (KB/s). Padrão 900.
 *   Se o servidor público derrubar a conexão, diminua (ex.: 400); se tiver servidor próprio, aumente.
 * FILE_CHUNK_BYTES: tamanho de cada pedaço (padrão 16384; entre 4096 e 49152).
 */
window.APP_CONFIG = { YOUTUBE_API_KEY: '', MQTT_BROKERS: null, FILE_RATE_KBPS: 900, FILE_CHUNK_BYTES: 16384 };
