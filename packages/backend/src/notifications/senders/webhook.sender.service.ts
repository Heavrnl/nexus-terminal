import axios, { Method } from "axios";
import { INotificationSender } from "../notification.dispatcher.service";
import { ProcessedNotification } from "../notification.processor.service";
import { WebhookConfig } from "../../types/notification.types";

class WebhookSenderService implements INotificationSender {
  async send(notification: ProcessedNotification): Promise<void> {
    const config = notification.config as WebhookConfig;
    const { url, method = "POST", headers = {} } = config;
    const requestBody = notification.body;

    if (!url) {
      console.error("[WebhookSender] Missing webhook URL in configuration.");
      throw new Error("Webhook configuration is incomplete (missing URL).");
    }

    try {
      new URL(url);
    } catch (e) {
      console.error(`[WebhookSender] Invalid webhook URL format: ${url}`);
      throw new Error(`Invalid webhook URL format: ${url}`);
    }

    const finalHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      ...headers,
    };

    const requestMethod: Method = method.toUpperCase() as Method;
    const validMethods: Method[] = [
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "HEAD",
      "OPTIONS",
    ];
    if (!validMethods.includes(requestMethod)) {
      console.error(
        `[WebhookSender] Invalid HTTP method specified: ${method}. Defaulting to POST.`
      );

      throw new Error(`Invalid HTTP method specified: ${method}`);
    }

    try {
      console.log(
        `[WebhookSender] Sending ${requestMethod} notification to webhook URL: ${url}`
      );

      let requestData: any = undefined;
      let requestParams: any = undefined;

      if (["POST", "PUT", "PATCH"].includes(requestMethod)) {
        if (
          finalHeaders["Content-Type"]
            ?.toLowerCase()
            .includes("application/json")
        ) {
          try {
            requestData = JSON.parse(requestBody);
          } catch (parseError: any) {
            console.warn(
              `[WebhookSender] Failed to parse request body as JSON for Content-Type application/json (${parseError.message}). Sending as raw string. Body: ${requestBody.substring(
                0,
                100
              )}...`
            );
            requestData = requestBody;
          }
        } else {
          requestData = requestBody;
        }
      } else if (requestMethod === "GET") {
        console.warn(
          `[WebhookSender] Sending data in body for GET request might not be standard. URL: ${url}`
        );
      }

      const response = await axios({
        method: requestMethod,
        url: url,
        headers: finalHeaders,
        data: requestData,
        params: requestParams,
        timeout: 15000,
      });

      if (response.status >= 200 && response.status < 300) {
        console.log(
          `[WebhookSender] Successfully sent notification to webhook. Status: ${response.status}`
        );
      } else {
        console.warn(
          `[WebhookSender] Webhook endpoint responded with status: ${response.status}`,
          response.data
        );
      }
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        console.error(
          `[WebhookSender] Axios error sending notification to ${url}: ${error.message}`,
          error.response?.status,
          error.response?.data
        );
        throw new Error(
          `Failed to send webhook notification (Axios Error): ${error.message}`
        );
      } else {
        console.error(
          `[WebhookSender] Unexpected error sending notification to ${url}:`,
          error
        );
        throw new Error(
          `Failed to send webhook notification (Unexpected Error): ${
            error.message || error
          }`
        );
      }
    }
  }
}

const webhookSenderService = new WebhookSenderService();
export default webhookSenderService;
