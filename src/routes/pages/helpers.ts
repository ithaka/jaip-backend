import { FastifyInstance } from "fastify";
import { Entitlement } from "../../types/accounts";
import {
  ALEResponse,
  CedarIdentityBlock,
  CedarItemView,
  CedarMetadataReturn,
  EntitlementMap,
} from "../../types/routes";
import { ALE_QUERY_SERVICE, CEDAR_DELIVERY_SERVICE } from "../../consts";
import axios, { AxiosResponse } from "axios";
import { jstor_types, status_options } from "@prisma/client";
import { ensure_error } from "../../utils";
import { LogPayload } from "../../event_handler";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { JAIPDatabase } from "../../database";

export const get_s3_object = async (
  str: string,
): Promise<[AxiosResponse | null, Error | null]> => {
  try {
    const url = new URL(str);

    const client = new S3Client({
      region: "us-east-1",
    });

    const command = new GetObjectCommand({
      Bucket: url.host,
      Key: url.pathname.substring(1),
    });

    const signed_url = await getSignedUrl(client, command, { expiresIn: 3600 });
    const response = await axios.get(signed_url, {
      responseType: "stream",
    });
    if (response.status !== 200) {
      throw new Error(`S3 object request failed: Status code not 200`);
    }
    return [response.data, null];
  } catch (err) {
    const error = ensure_error(err);
    return [null, error];
  }
};

const get_page_index = (i: string, min: number, max: number): number => {
  let pi = parseInt(i, 10);
  if (isNaN(pi) || pi < min || pi >= max) {
    pi = 0;
  }
  return pi;
};

export const get_page_url = (
  cedar: CedarItemView[],
  page_index: string,
): [string, number] => {
  for (const item of cedar) {
    if (!page_index && item.pdf) {
      return [item.pdf, 0];
    } else if (page_index && item.page_images.length > 0) {
      const page_images = item.page_images;
      const pi = get_page_index(page_index, 0, page_images.length);
      return [page_images[pi], pi];
    }
  }
  return ["", 0];
};

export const get_and_extract_metadata = async (
  fastify: FastifyInstance,
  iid: string,
  log_payload: LogPayload,
) => {
  log_payload.item_id = iid;
  try {
    fastify.log.info(`Attempting to get Cedar metadata for ${iid}`);
    const cedar_metadata = await get_cedar_metadata(fastify, iid);
    if (cedar_metadata instanceof Error) {
      throw cedar_metadata;
    }

    fastify.log.info(`Attempting to extract cedar metadata for ${iid}`);
    const extracts = extract_metadata(cedar_metadata, log_payload);
    if (extracts instanceof Error) {
      throw extracts;
    }
    return extracts;
  } catch (err) {
    const error = ensure_error(err);
    return error;
  }
};

export const extract_metadata = (
  metadata: [CedarIdentityBlock, CedarItemView[]],
  log_payload: LogPayload,
) => {
  try {
    const [cedar_identity_data, cedar_item_view_data] = metadata;

    // Extract search terms from cedar metadata
    const journal_iids = cedar_identity_data.journal_iid;
    const doi = cedar_item_view_data.find((item) => item.doi)?.doi;

    const codes =
      cedar_item_view_data.find((item) => {
        return item.disc_code
      })?.disc_code || [];
    const disciplines = cedar_item_view_data.find((item) => {
      return item.disciplines
    })?.disciplines;
    const disc_codes = codes.concat(Object.keys(disciplines || {}));

    // Add metadata to log payload
    log_payload.doi = doi;
    log_payload.item_doi = doi;
    log_payload.stable_url = `stable/${doi}`;
    log_payload.disciplines = disc_codes;
    log_payload.journals = journal_iids;

    if (!doi) {
      throw new Error(`Cedar metadata request failed: No doi found.`);
    }
    return {
      doi,
      journal_iids,
      disc_codes,
      cedar_item_view_data,
    };
  } catch (err) {
    const error = ensure_error(err);
    return error;
  }
};

export const get_cedar_metadata = async (
  fastify: FastifyInstance,
  iid: string,
): Promise<[CedarIdentityBlock, CedarItemView[]] | Error> => {
  try {
    const [cedar_host, cedar_error] = await fastify.discover(
      CEDAR_DELIVERY_SERVICE.name,
    );
    if (cedar_error) {
      throw cedar_error;
    }

    // Get both the identity block and item view metadata
    const url = `${cedar_host}${CEDAR_DELIVERY_SERVICE.path}`;
    fastify.log.info(`Cedar metadata URL: ${url}`);
    const cedar_identity_promise = axios.get(url, {
      params: {
        ...CEDAR_DELIVERY_SERVICE.queries.params.identity_block,
        iid,
      },
    });
    const cedar_item_view_promise = axios.get(url, {
      params: {
        ...CEDAR_DELIVERY_SERVICE.queries.params.item_view,
        iid,
      },
    });

    // Wait for both requests to finish
    const [cedar_identity_response, cedar_item_view_response] =
      await Promise.allSettled([cedar_identity_promise, cedar_item_view_promise]);

    if (cedar_identity_response.status === "rejected") {
      throw new Error(
        `Cedar identity metadata request failed: ${cedar_identity_response.reason}`,
      );
    }
    if (cedar_item_view_response.status === "rejected") {
      throw new Error(
        `Cedar item view metadata request failed: ${cedar_item_view_response.reason}`,
      );
    }

    // Check if the requests were successful
    if (cedar_identity_response.value.status !== 200) {
      throw new Error(
        `Cedar identity metadata request failed: Status code not 200`,
      );
    }
    if (cedar_item_view_response.value.status !== 200) {
      throw new Error(
        `Cedar item view metadata request failed: Status code not 200`,
      );
    }

    return [cedar_identity_response.value.data, cedar_item_view_response.value.data];
  } catch (err) {
    const error = ensure_error(err);
    return error;
  }
};

export const get_is_forbidden = async (
  db: JAIPDatabase,
  is_authenticated_student: boolean,
  doi: string,
  journal_iids: string[],
  disc_codes: string[],
  group_ids: number[],
): Promise<boolean> => {
  if (!is_authenticated_student) {
    return false;
  }

  let is_forbidden = true;
  // Check if the item is approved individually
  const [item_status, error] = await db.get_item_status({
    where: {
      jstor_item_id: doi,
      group_id: {
        in: group_ids,
      },
    },
    orderBy: {
      created_at: "desc",
    },
  });
  if (error) {
    throw error;
  }
  // If the item is approved, we can allow access
  if (item_status?.status === status_options.Approved) {
    is_forbidden = false;
  } else if (item_status?.status !== status_options.Denied) {
    // If the item is not denied, we need to check the journal and discipline statuses
    // If it is denied, we can jump directly to denying access
    const [journal_status, error] = await db.get_item_status({
      where: {
        jstor_item_type: jstor_types.headid,
        jstor_item_id: {
          in: journal_iids,
        },
        group_id: {
          in: group_ids,
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });
    if (error) {
      throw error;
    }
    // If it's approved by journal, we don't need to check the discipline
    if (journal_status?.status === status_options.Approved) {
      is_forbidden = false;
    } else {
      const [discipline_status, error] = await db.get_item_status({
        where: {
          jstor_item_type: jstor_types.discipline,
          jstor_item_id: {
            in: disc_codes,
          },
          group_id: {
            in: group_ids,
          },
        },
        orderBy: {
          created_at: "desc",
        },
      });
      if (error) {
        throw error;
      }
      if (discipline_status?.status === status_options.Approved) {
        is_forbidden = false;
      }
    }
  }
  return is_forbidden;
};

export const get_entitlement_map = async (
  fastify: FastifyInstance,
  iid: string,
  uuid: string,
): Promise<EntitlementMap> => {
  fastify.log.info(`Attempting to get ALE metadata for ${iid}`);
  const [ale_host, ale_error] = await fastify.discover(ALE_QUERY_SERVICE.name);
  if (ale_error) {
    throw ale_error;
  }

  const ale_url = `${ale_host}${ALE_QUERY_SERVICE.path}`;
  fastify.log.info(`ALE metadata URL: ${ale_url}`);
  const ale_response = await axios.get(ale_url, {
    params: {
      uuid,
      contentIds: iid,
    },
  });
  if (ale_response.status !== 200) {
    throw new Error(`ALE metadata request failed: Status code not 200`);
  }
  const ale_data: ALEResponse[] = ale_response.data.results;
  const entitlements = combine_entitlements(ale_data);

  return create_entitlement_map(entitlements);
};

export const create_entitlement_map = (
  entitlements: Entitlement[],
): EntitlementMap => {
  const entitlement_map: EntitlementMap = {};
  const priority = 0;
  for (const entitlement of entitlements) {
    for (const lic of entitlement.licenses) {
      if (!entitlement_map[lic.id]) {
        entitlement_map[lic.id] = [];
      }
      const new_license = {
        license: lic.id,
        licenseType: lic.type.value,
        licenseSubType: lic.subType,
        licensePriority: priority,
        ddaThreshold: {
          pdf_download: 0,
          view_item: 0,
        },
        entitlement: entitlement.entitlementId,
        licenseTags: lic.tags,
        licenseLegacyID: lic.legacyId,
      };
      entitlement_map[lic.id].push(new_license);
    }
  }
  return entitlement_map;
};
export const combine_entitlements = (
  ale_response: ALEResponse[],
): Entitlement[] => {
  const combined = [];
  for (const resp of ale_response) {
    combined.push(...resp.sessionEntitlements);
  }
  return combined;
};

export const get_md_from_cedar = (
  cedar: CedarItemView[],
  md: CedarMetadataReturn,
): CedarMetadataReturn => {
  for (const item of cedar) {
    if (item.item_type && !md.itemType) {
      md.itemType = item.item_type;
    }
    if (item.content_type && !md.contentType) {
      md.contentType = item.content_type;
    }
    if (item.bidirectional_category && md.isRightToLeft === null) {
      md.isRightToLeft = item.bidirectional_category === "right_to_left";
    }
    if (item.page_images.length > 0 && md.pageCount === 0) {
      md.pageCount = parseInt(item.page_count, 10);
    }
    if (
      md.itemType &&
      md.contentType &&
      md.isRightToLeft !== null &&
      md.pageCount !== 0
    ) {
      break;
    }
  }
  return md;
};
