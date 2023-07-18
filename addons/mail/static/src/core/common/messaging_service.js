/* @odoo-module */

import { CannedResponse } from "@mail/core/common/canned_response_model";
import { cleanTerm } from "@mail/utils/common/format";

import { reactive } from "@odoo/owl";

import { _t } from "@web/core/l10n/translation";
import { registry } from "@web/core/registry";
import { Deferred } from "@web/core/utils/concurrency";

/**
 * @typedef {Messaging} Messaging
 */
export class Messaging {
    constructor(...args) {
        this.setup(...args);
    }

    setup(env, services) {
        this.env = env;
        /** @type {import("@mail/core/common/store_service").Store} */
        this.store = services["mail.store"];
        this.rpc = services.rpc;
        this.orm = services.orm;
        /** @type {import("@mail/core/common/attachment_service").AttachmentService} */
        this.attachmentService = services["mail.attachment"];
        /** @type {import("@mail/core/common/user_settings_service").UserSettings} */
        this.userSettingsService = services["mail.user_settings"];
        /** @type {import("@mail/core/common/thread_service").ThreadService} */
        this.threadService = services["mail.thread"];
        /** @type {import("@mail/core/common/message_service").MessageService} */
        this.messageService = services["mail.message"];
        /** @type {import("@mail/core/common/persona_service").PersonaService} */
        this.personaService = services["mail.persona"];
        this.router = services.router;
        this.bus = services.bus_service;
        this.isReady = new Deferred();
        this.imStatusService = services.im_status;
        const user = services.user;
        this.personaService.insert({ id: user.partnerId, type: "partner", isAdmin: user.isAdmin });
        this.registeredImStatusPartners = reactive([], () => this.updateImStatusRegistration());
        this.store.registeredImStatusPartners = this.registeredImStatusPartners;
        this.store.discuss.inbox = this.threadService.insert({
            id: "inbox",
            model: "mail.box",
            name: _t("Inbox"),
            type: "mailbox",
        });
        this.store.discuss.starred = this.threadService.insert({
            id: "starred",
            model: "mail.box",
            name: _t("Starred"),
            type: "mailbox",
            counter: 0,
        });
        this.store.discuss.history = this.threadService.insert({
            id: "history",
            model: "mail.box",
            name: _t("History"),
            type: "mailbox",
            counter: 0,
        });
        this.updateImStatusRegistration();
    }

    /**
     * Import data received from init_messaging
     */
    initialize() {
        this.rpc("/mail/init_messaging", {}, { silent: true }).then(
            this.initMessagingCallback.bind(this)
        );
    }

    initMessagingCallback(data) {
        if (data.current_partner) {
            this.store.user = this.personaService.insert({
                ...data.current_partner,
                type: "partner",
            });
        }
        if (data.currentGuest) {
            this.store.guest = this.personaService.insert({
                ...data.currentGuest,
                type: "guest",
                channelId: data.channels[0]?.id,
            });
        }
        this.store.odoobot = this.personaService.insert({
            ...data.odoobot,
            type: "partner",
        });
        const settings = data.current_user_settings;
        this.userSettingsService.updateFromCommands(settings);
        this.userSettingsService.id = settings.id;
        this.store.companyName = data.companyName;
        this.store.discuss.inbox.counter = data.needaction_inbox_counter;
        this.store.internalUserGroupId = data.internalUserGroupId;
        this.store.discuss.starred.counter = data.starred_counter;
        this.store.discuss.isActive =
            data.menu_id === this.router.current.hash?.menu_id ||
            this.router.hash?.action === "mail.action_discuss";
        (data.shortcodes ?? []).forEach((code) => {
            this.insertCannedResponse(code);
        });
        this.store.hasLinkPreviewFeature = data.hasLinkPreviewFeature;
        this.store.initBusId = data.initBusId;
        this.isReady.resolve(data);
        this.store.isMessagingReady = true;
    }

    updateImStatusRegistration() {
        this.imStatusService.registerToImStatus(
            "res.partner",
            /**
             * Read value from registeredImStatusPartners own reactive rather than
             * from store reactive to ensure the callback keeps being registered.
             */
            [...this.registeredImStatusPartners]
        );
    }

    // -------------------------------------------------------------------------
    // process notifications received by the bus
    // -------------------------------------------------------------------------

    handleNotification(notifications) {
        for (const notif of notifications) {
            switch (notif.type) {
                case "ir.attachment/delete":
                    {
                        const { id: attachmentId, message: messageData } = notif.payload;
                        if (messageData) {
                            this.messageService.insert({
                                ...messageData,
                            });
                        }
                        const attachment = this.store.attachments[attachmentId];
                        if (attachment) {
                            this.attachmentService.remove(attachment);
                        }
                    }
                    break;
            }
        }
    }

    // -------------------------------------------------------------------------
    // actions that can be performed on the messaging system
    // -------------------------------------------------------------------------

    async searchPartners(searchStr = "", limit = 10) {
        let partners = [];
        const searchTerm = cleanTerm(searchStr);
        for (const localId in this.store.personas) {
            const persona = this.store.personas[localId];
            if (persona.type !== "partner") {
                continue;
            }
            const partner = persona;
            // todo: need to filter out non-user partners (there was a user key)
            // also, filter out inactive partners
            if (partner.name && cleanTerm(partner.name).includes(searchTerm)) {
                partners.push(partner);
                if (partners.length >= limit) {
                    break;
                }
            }
        }
        if (!partners.length) {
            const partnersData = await this.orm.silent.call("res.partner", "im_search", [
                searchTerm,
                limit,
            ]);
            partners = partnersData.map((data) =>
                this.personaService.insert({ ...data, type: "partner" })
            );
        }
        return partners;
    }

    openDocument({ id, model }) {
        this.env.services.action.doAction({
            type: "ir.actions.act_window",
            res_model: model,
            views: [[false, "form"]],
            res_id: id,
        });
    }

    insertCannedResponse(data) {
        let cannedResponse = this.store.cannedResponses[data.id];
        if (!cannedResponse) {
            this.store.cannedResponses[data.id] = new CannedResponse();
            cannedResponse = this.store.cannedResponses[data.id];
        }
        Object.assign(cannedResponse, {
            id: data.id,
            name: data.source,
            substitution: data.substitution,
        });
        return cannedResponse;
    }
}

export const messagingService = {
    dependencies: [
        "mail.store",
        "rpc",
        "orm",
        "user",
        "router",
        "bus_service",
        "im_status",
        "mail.attachment",
        "mail.user_settings",
        "mail.thread",
        "mail.message",
        "mail.persona",
    ],
    start(env, services) {
        const messaging = new Messaging(env, services);
        messaging.initialize();
        messaging.isReady.then(() => {
            services.bus_service.addEventListener("notification", (notifEvent) => {
                messaging.handleNotification(notifEvent.detail);
            });
            services.bus_service.start();
        });
        return messaging;
    },
};

registry.category("services").add("mail.messaging", messagingService);
