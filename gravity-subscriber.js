// const { setTimeout } = require('timers/promises');

module.exports = function(RED) {

    function SubscriberNode(config) {

		const util = require('util');

        RED.nodes.createNode(this, config);
        var node = this;

		// Getting server information from gravity server node
		this.server = RED.nodes.getNode(config.server)

		function setStatus(type) {
			switch(type) {
			case 'connected':
				node.status({
					fill: 'green',
					shape: 'dot',
					text: 'connected'
				});
				break;
			case 'connecting':
				node.status({
					fill: 'yellow',
					shape: 'ring',
					text: 'connecting'
				});
				break;
			case 'registering':
				node.status({
					fill: 'yellow',
					shape: 'ring',
					text: 'registering'
				});
				break;
			case 'initializing':
				node.status({
					fill: 'yellow',
					shape: 'ring',
					text: 'initializing'
				});
				break;
			case 'disconnected':
				node.status({
					fill: 'red',
					shape: 'ring',
					text: 'disconnected'
				});
				break;
			case 'receiving':
				node.status({
					fill: 'blue',
					shape: 'ring',
					text: 'receiving'
				});
				break;
			case 'productNotFound':
				node.status({
					fill: 'red',
					shape: 'ring',
					text: 'ERR: product not found'
				});
				break;
			}
		}

		function ack() {
			this.ack();
			setStatus('connected');
		}

		setStatus('disconnected');

		let uuid = require('uuid');
		let Gravity = require('gravity-sdk');
		let batchSize;
		let batchArr =  [];
		let timerId = null;
		let timeout = config.timeout;
		let currentMsgAck = null;

		function setTimer(){
			if (timerId){
				clearTimeout(timerId);
			}

			timerId = setTimeout( ()=>{
				if (batchArr.length > 0){
					node.send({payload:batchArr,ack:currentMsgAck.ack});
				}
			},timeout*1000)
		}

		function resetTimer(){
			if (timerId){
				clearTimeout(timerId);
			}
			setTimer();
		}

		async function initSubscriber(client) {

			// Not specify product
			if (!config.product || config.product.length == 0) {
				setStatus('connected');
				return;
			}

			setStatus('initializing');

			// Subscribe to product
			let product = await client.getProduct(config.product);
			let subOpts = {
				seq: Number(config.startseq) || 1,
				delivery: config.delivery || 'new'
			};

			if (config.delivery == 'startSeq') {
				node.log(util.format('Initializing subscriber (domain=%s, product=%s, delivery=%s, seq=%d)', client.opts.domain, product.name, subOpts.delivery, subOpts.seq));
			} else {
				node.log(util.format('Initializing subscriber (domain=%s, product=%s, delivery=%s)', client.opts.domain, product.name, subOpts.delivery));
			}

			if (config.batchMode){
				batchSize = 1000;
				node.log(util.format('Batch Mode is On and timeout is %d',timeout));
			}

			let sub = await product.subscribe([], subOpts);

			sub.on('event', (m) => {
				setStatus('receiving');

				let subPayload = {
					seq: m.seq,
					eventName: m.data.eventName,
					table: m.data.table,
					primaryKeys: m.data.primaryKeys,
					primaryKey: m.data.primaryKey,
					time: m.time,
					timeNano: m.timeNano,
					record: m.data.record,
				}

				currentMsgAck = {
					ack:ack.bind(m),
				};

				if(config.batchMode){
					let payload = {
						subPayload:subPayload,
						natsMsgId: m.seq.toString()
					}
					batchArr.push(payload);
					if (batchArr.length >= batchSize){
						if(timerId){
							clearTimeout(timerId);
							timerId = null;
						}
						node.send({payload:batchArr,ack:ack.bind(m)});
						batchArr = [];
					}else{
						ack.bind(m)();
					}
					resetTimer();
				}else{
					node.send({payload:subPayload,natsMsgId: m.seq.toString(),ack:ack.bind(m)});
				}

				if (!config.manuallyAck)
					ack.bind(m)();
			});

			node.log(util.format('Subscriber is ready (domain=%s, product=%s, delivery=%s, batchMode=%s)', client.opts.domain, product.name, subOpts.delivery,config.batchMode));

			node.on('close', async () => {
				node.log(util.format('Closing subscriber (domain=%s, product=%s, delivery=%s)', client.opts.domain, product.name, subOpts.delivery));
				await sub.unsubscribe();
			});

			setStatus('connected');
		}




		if (!node.server) {
			setStatus('disconnected');
			return;
		}

		let accessToken = '';
		if (node.credentials) {
			accessToken = node.credentials.accessToken || '';
		}

		let client = new Gravity.Client({
			servers: node.server.server + ':' + node.server.port,
			domain: config.domain || 'default',
			token: accessToken,
			waitOnFirstConnect: true
		});
		node.gravityClient = client;

		// Initializing event handlers
		client.on('disconnect', () => {
			setStatus('disconnected');
		});

		client.on('reconnect', () => {
			node.log('Reconnecting to Gravity... ' + client.opts.servers);
			setStatus('connecting');
		});

		client.on('connected', () => {

			setStatus('connected');

			initSubscriber(client).catch((e) => {
				node.error(e);
				setStatus('productNotFound');
			});
		});

		// Connect to gravity
		setStatus('connecting');
		node.log('Connecting to Gravity... ' + client.opts.servers);
		client.connect();

		node.on('close', async () => {
			node.log('Close current connection');
			setStatus('disconnected');
			client.disconnect();
		});
    }

    RED.nodes.registerType('Gravity Subscriber', SubscriberNode, {
		credentials: {
			appID: { type: 'text' },
			accessToken: { type: 'text' }
		}
	});
}
