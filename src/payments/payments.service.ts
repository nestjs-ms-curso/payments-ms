import { Inject, Injectable, Logger } from '@nestjs/common';
import { envs } from 'src/config';
import Stripe from 'stripe';
import { PaymentSessionDto } from './dto/payment-session.dto';
import { Request, Response } from 'express';
import { NATS_SERVICE } from 'src/config/services';
import { ClientProxy } from '@nestjs/microservices';

@Injectable()
export class PaymentsService {
  private readonly stripe = new Stripe(envs.stripeSecret);
  private readonly logger = new Logger('Payments');

  constructor(
    @Inject(NATS_SERVICE) private readonly client: ClientProxy,
  ) {}

  async createPaymentSession(paymentSessionDto: PaymentSessionDto) {
    const { currency, items, orderId } = paymentSessionDto;

    const lineItems = items.map(({ name, price, quantity }) => ({
      price_data: {
        currency,
        product_data: {
          name,
        },
        unit_amount: Math.round(price * 100), // 20 dolares = 2000 / 100 = 20.00
      },
      quantity,
    }));

    const session = await this.stripe.checkout.sessions.create({
      // colocar aqui el ID de mi orden
      payment_intent_data: {
        metadata: { orderId },
      },
      line_items: lineItems,
      mode: 'payment',
      success_url: envs.stripeSuccessUrl,
      cancel_url: envs.stripeCancelUrl,
    });

    return {
      cancelUrl: session.cancel_url,
      successUrl: session.success_url,
      url: session.url,
    };
  }

  async stripeWebhook(req: Request, res: Response) {
    const sig = req.headers['stripe-signature'] as string;

    let event: Stripe.Event;
    const endpointSecret = envs.stripeEndpointSecret;

    try {
      event = this.stripe.webhooks.constructEvent(req['rawBody'], sig, endpointSecret);
    } catch (error) {
      res.status(400).send(`Webhook error ${error.message}`);
      return;
    }

    switch(event.type){
      case 'charge.succeeded':
        const chargeSucceded = event.data.object;
        // llamar a nuestro ms
        /* console.log({
          medata: chargeSucceded.metadata,
          orderId: chargeSucceded.metadata.orderId,
        }); */
        const payload = {
          stripePaymentId: chargeSucceded.id,
          orderId: chargeSucceded.metadata.orderId,
          receiptUrl: chargeSucceded.receipt_url,
        };

        // this.logger.log({ payload });
        this.client.emit('payment.succeeded', payload);
      break;

      default:
        console.log(`Event ${event.type} not handled`);
    }

    return res.status(200).json({ sig });
  }
}
