const LoggingObject = require('../LoggingObject');
const EventSource = require('eventsource');
const handleLogLine = require('../../../../worker/processors/logs/handleLogLine');
const ThrottledFunction = require('../../../../worker/util/throttledFunction');


class SdtdSSE extends LoggingObject {
  constructor(server) {
    super(server);

    this.RATE_LIMIT_MINUTES = parseInt(process.env.SSE_RATE_LIMIT_MINUTES, 10) || 5;
    this.RATE_LIMIT_AMOUNT = parseInt(process.env.SSE_RATE_LIMIT_AMOUNT, 10) || 2500;
    this.THROTTLE_DELAY = parseInt(process.env.SSE_THROTTLE_DELAY, 10) || 1000 * 60 * 1;
    this.SSE_THROTTLE_RECONNECT_DELAY = parseInt(process.env.SSE_THROTTLE_RECONNECT_DELAY, 10) || 1000 * 60 * 5;
    this.SSE_RECONNECT_INTERVAL = parseInt(process.env.SSE_RECONNECT_INTERVAL, 10) || 1000 * 60 * 3;
    // If we last received a message longer ago than this, we'll force a reconnect
    this.LAST_MESSAGE_THRESHOLD = parseInt(process.env.SSE_RECONNECT_INTERVAL, 10) || 1000 * 60 * 5;


    this.SSERegex = /\d+-\d+-\d+T\d+:\d+:\d+ \d+\.\d+ INF (.+)/;
    this.throttledFunction = new ThrottledFunction(this.SSEListener.bind(this), this.RATE_LIMIT_AMOUNT, this.RATE_LIMIT_MINUTES);
    this.listener = this.throttledFunction.listener;
    this.queuedChatMessages = [];
    this.lastMessage = Date.now();
    this.throttleDestructionTimeout = null;
    this.throttleReconnectTimeout = null;



    this.throttledFunction.on('normal', () => {
      sails.log.debug(`SSE normal for server ${this.server.id}`, { server: this.server });
      clearTimeout(this.throttleDestructionTimeout);
      sails.helpers.discord.sendNotification({
        serverId: this.server.id,
        notificationType: 'sseThrottled',
        type: 'normal'
      }).then().catch(e => { sails.log.error(`Error sending SSE throttled notification for server ${this.server.id}`, { server: this.server, error: e }); });

      this.start();
    });

    this.throttledFunction.on('throttled', () => {
      sails.log.debug(`SSE throttled for server ${this.server.id}`, { server: this.server });
      this.throttleDestructionTimeout = setTimeout(this.destroy.bind(this), this.THROTTLE_DELAY);
      this.throttleReconnectTimeout = setTimeout(this.start.bind(this), this.SSE_THROTTLE_RECONNECT_DELAY);
      sails.helpers.discord.sendNotification({
        serverId: this.server.id,
        notificationType: 'sseThrottled',
        type: 'throttled'
      }).then().catch(e => { sails.log.error(`Error sending SSE throttled notification for server ${this.server.id}`, { server: this.server, error: e }); });
    });

    this.reconnectInterval = setInterval(() => this.reconnectListener(), this.SSE_RECONNECT_INTERVAL);
  }

  reconnectListener() {
    if (!this.eventSource) {
      // Event source isn't active, we should not be reconnecting it
      return;
    }

    if (this.lastMessage < (Date.now() - this.LAST_MESSAGE_THRESHOLD)) {
      this.keepAliveHandler();
    }

  }

  keepAliveHandler() {
    if (!this.keepAliveSent) {
      sails.log.debug(`Sending keepalive to SSE for server ${this.server.id}`, { server: this.server });
      sails.helpers.sdtdApi.executeConsoleCommand(SdtdServer.getAPIConfig(this.server), `version`)
        // Only catch to prevent unhandledRejections
        // No need to await, this is fire and forget
        .catch(e => {
          // Do nothing
          // If this fails, the next time this is called, it will try to reconnect
        });
      this.keepAliveSent = true;
    } else {
      this.keepAliveSent = false;
      sails.log.debug(`Trying to reconnect SSE for server ${this.server.id}`, { serverId: this.server.id });
      this.destroy();
      this.start();
    }
  }

  get url() {
    return `http://${this.server.ip}:${this.server.webPort}/sse/log?adminuser=${this.server.authName}&admintoken=${this.server.authToken}`;
  }

  start() {
    if (this.eventSource) {
      return;
    }
    clearTimeout(this.throttleReconnectTimeout);

    sails.log.info(`Starting SSE`, { server: this.server });

    this.eventSource = new EventSource(encodeURI(this.url));
    this.eventSource.reconnectInterval = 5000;
    this.eventSource.addEventListener('logLine', this.listener);
    this.eventSource.onerror = e => {
      sails.log.warn(`SSE error for server ${this.server.id}`, { server: this.server, error: e });
    };
    this.eventSource.onopen = () => {
      sails.log.info(`Opened a SSE channel for server ${this.server.id}`, { server: this.server });
    };
  }

  destroy() {
    if (!this.eventSource) {
      return;
    }
    sails.log.info(`Destroying SSE`, { server: this.server });

    this.eventSource.removeEventListener('logLine', this.listener);
    this.eventSource.close();
    this.eventSource = null;
  }

  async SSEListener(data) {
    this.lastMessage = Date.now();
    try {
      const parsed = JSON.parse(data.data);
      sails.log.debug(`Raw SSE event received`, { serverId: this.server.id, event: _.omit(parsed, 'server') });
      const messageMatch = this.SSERegex.exec(parsed.msg);
      if (messageMatch && messageMatch[1]) {
        parsed.msg = messageMatch[1];
      }
      const log = handleLogLine(parsed);
      if (log) {
        if (log.type === 'chatMessage' || log.data.msg.includes('-non-player-')) {
          return this.pushChatMessage(log);
        }

        await this.handleMessage(log);
      }
    } catch (error) {
      sails.log.error(error.stack, { server: this.server });
    }
  }

  /**
   * When a mod intercepts a chat message, it will send out two messages
   * One is the original chat message
   * and the other is the modified message
   * The modified message is not interesting to us, so we should ignore it
   * The original message will include all the data we need (steamId, chat text, ...)
   */
  async pushChatMessage(chatMessage) {
    const previouslyQueued = this.queuedChatMessages[this.queuedChatMessages.length - 1];
    if (previouslyQueued) {
      if (previouslyQueued.data.messageText === chatMessage.data.messageText) {
        previouslyQueued.type = 'logLine';
      }
      await this.handleMessage(previouslyQueued);
      await this.handleMessage(chatMessage);
      this.queuedChatMessages = [];
    } else {
      this.queuedChatMessages.push(chatMessage);
      // If a chatmessage does not get handled by a mod, we still need some way to react to it
      // This is achieved by setting a timeout
      // If no messages comes in before the timeout, it will send out the original chat message
      this.chatMsgLock = setTimeout(() => {
        const previouslyQueued = this.queuedChatMessages[this.queuedChatMessages.length - 1];
        this.queuedChatMessages = [];
        if (previouslyQueued) {
          return this.handleMessage(previouslyQueued);
        }
      }, 250);
    }
  };
}

module.exports = SdtdSSE;
