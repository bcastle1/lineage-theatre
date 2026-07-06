import type { EmailOutboxItem, MovieProject } from "../types";
import { createId, nowIso } from "../lib/runtime";

export interface VideoGenerationRequest {
  project: MovieProject;
  renderMode: "trailer" | "full";
}

export interface VideoGenerationAdapter {
  render(request: VideoGenerationRequest): Promise<{ previewUrl: string; downloadUrl: string }>;
}

export interface PaymentAdapter {
  createCheckout(project: MovieProject, amount: number): Promise<{ paymentUrl: string }>;
  verifyPayment(project: MovieProject): Promise<boolean>;
}

export interface EmailAdapter {
  sendReceipt(project: MovieProject, to: string): Promise<EmailOutboxItem>;
}

export interface PublishAdapter {
  publish(project: MovieProject): Promise<{ youtubeUrl?: string; familyGalleryUrl?: string }>;
}

export const localVideoAdapter: VideoGenerationAdapter = {
  async render({ project, renderMode }) {
    const suffix = renderMode === "trailer" ? "trailer" : "full-movie";
    return {
      previewUrl: `/local-render/${project.id}/${suffix}`,
      downloadUrl: `/downloads/${project.id}-${suffix}.mp4`,
    };
  },
};

export const venmoLocalAdapter: PaymentAdapter = {
  async createCheckout() {
    return { paymentUrl: "https://venmo.com/ERik-Castle-1" };
  },
  async verifyPayment() {
    return false;
  },
};

export const localEmailAdapter: EmailAdapter = {
  async sendReceipt(project, to) {
    return {
      id: createId("email"),
      to,
      subject: `Lineage Theatre receipt ${project.payment.receiptNumber}`,
      body: `Receipt ${project.payment.receiptNumber} for ${project.title}: $${project.payment.amount}.`,
      status: "queued",
      createdAt: nowIso(),
    };
  },
};

export const localPublishAdapter: PublishAdapter = {
  async publish(project) {
    return {
      familyGalleryUrl: project.preferences.publishToFamilyGallery
        ? `/family-gallery/${project.id}`
        : undefined,
      youtubeUrl: project.preferences.publishToYoutube ? "Connect YouTube OAuth in production" : undefined,
    };
  },
};
