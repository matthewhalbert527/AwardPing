import "server-only";
import { createHash } from "node:crypto";
import type { DirectoryFilterField } from "./award-directory-filters";
import type { PublicAwardFacts } from "./public-award-facts";

type ReviewFacts = Pick<PublicAwardFacts, "academicLevels" | "disciplines" | "citizenship" | "eligibility">;
// Versioned 2026-11-02 review of all 50 current programs. Tags are discovery
// aids, not new eligibility claims. Official provider guidance and the exact
// review decisions are retained in the private release audit.
// Only identity + relevant approved details bind a review. Dates/amounts can
// change without losing valid tags; changed eligibility or audience fields
// expire it automatically. Nothing here approves or rewrites public facts.
const reviews: Readonly<Record<string, Record<DirectoryFilterField, readonly string[]>>> = {
  "166aea45902ee1e1e57d49acfd4f52b1af738bcc3dbd9b8044709dd6bb9df7c6": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Natural sciences",
      "Health & medicine",
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "13c4da696c8fd7b5b45477125167e2832b3bc998dbba5d7b1c3f0f1233bfdf63": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "e9f3da88e5c7638cede3b0ccc5bac4877c1d49a11d02a733819fd00b0cf73aa1": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "Social sciences & policy",
      "Arts"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "Country-specific criteria"
    ]
  },
  "c71cc0d0ed4205f7e92c4a8a019c58720a85d6043d2b7e29273f9e93eb20578d": {
    "academicLevels": [
      "Degree holder"
    ],
    "disciplines": [
      "Arts"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "daeb3438c090ad47c28dc90038221901c377b4a9311608112870ffddb7cf25ed": {
    "academicLevels": [
      "Undergraduate",
      "Graduate",
      "Master's",
      "Doctoral",
      "Professional"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "ed00d308a61af69ced4d76cf7cfb6e11ffc6d1549d2cdc477fe1a00244b3ff6a": {
    "academicLevels": [
      "Degree holder",
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "Country-specific criteria"
    ]
  },
  "cb91fdd5ea86c895cf062f12e7b66da6560b08a651cd69d120962ec8869f70ba": {
    "academicLevels": [
      "Undergraduate",
      "Recent graduate",
      "Degree holder"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "1507ab4e96494fbc27d56d296792b5e2e1cf8c7a9dcf7032aed34e8db0be5029": {
    "academicLevels": [
      "Undergraduate",
      "Graduate",
      "Master's",
      "Doctoral",
      "Professional"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "Country-specific criteria"
    ]
  },
  "721bce4dc408189a0c04cc8a5728af859fd5e3e7ce27814ea5a393f492506826": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Natural sciences",
      "Environment & earth sciences"
    ],
    "citizenship": [
      "U.S. citizens",
      "Country-specific criteria"
    ]
  },
  "e60d620eec314c6f7fcc0b4e791091dbb0f256df69f6c14ac5c6e58f893c6262": {
    "academicLevels": [
      "Degree holder",
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents",
      "Country-specific criteria"
    ]
  },
  "f20d7c884d3edddedb1f5168d294c1f061d22abeaca2c1056e6a5f7b329c57d6": {
    "academicLevels": [
      "Undergraduate",
      "Graduate",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "207d518e51d6af575eecb842c33a4c8afd2248c6874cd3fad3d72e69bcd0c6bf": {
    "academicLevels": [
      "Degree holder",
      "Graduate",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Health & medicine"
    ],
    "citizenship": [
      "Other / not listed"
    ]
  },
  "b2ed21dedf4261a68fef078c139e8049af5a7f6ad2c1b4a83941db0fbfac753f": {
    "academicLevels": [
      "Undergraduate",
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "7c4609d2ea8371e6c4106750cf9c955029f406e93d84662b70dc6394a7c8dd9e": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "ee27122c9f7321cf54ec15b22bc3f6b551949e6a93d79901ea9c3942ffe170ac": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "4819c96f58ff0b5ac5dfc4cbe7e6fba01357cf6f771f6758f004211f0252cf05": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "Country-specific criteria"
    ]
  },
  "b6b48c87a5594ba64ec704812da276e095677f5c4e5b76c4e1d090adbc344a8e": {
    "academicLevels": [
      "Undergraduate",
      "Recent graduate"
    ],
    "disciplines": [
      "Social sciences & policy",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "Country-specific criteria",
      "Work authorization"
    ]
  },
  "56f0816041883420dda27dd45afe8bf582281c0e0c54ed820592ecbab314dfde": {
    "academicLevels": [
      "Graduate",
      "Master's",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "Country-specific criteria"
    ]
  },
  "5e0b163dd7b5e51f84802fb9112aec9526ede22534bf1cb08dda02fb6d8570a1": {
    "academicLevels": [
      "Graduate",
      "Master's",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "692f3dc51bc7508109ff23cc4971528ec9a73c22814da6812d2b615cb790581c": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "Country-specific criteria"
    ]
  },
  "650fea3ce7c5c8bf14bdc96c3062ff50b4ce8480fddb68f003e5e4fe93214628": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "U.S. permanent residents"
    ]
  },
  "71a0559bf0db238aa3e32aa86d790ea2c11b45232f9d9a567e31a1ab082e12d6": {
    "academicLevels": [
      "Undergraduate",
      "Graduate",
      "Master's",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "39b21083ff439097c51f43f6c8622519992602a8a45956bfa773aa1fbda78e9b": {
    "academicLevels": [
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "Social sciences & policy",
      "Arts",
      "Education"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "f345d9d4c6b8b81e3d157da2671e6fe0aaac7b9c6c3fab16615f846ea1581b4d": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's",
      "Doctoral",
      "Professional"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "DACA / undocumented",
      "All nationalities"
    ]
  },
  "d6b9eea32eba9cc7aee1ef21e89164437d514af2e2ebe78f1ed322452b4d1c5e": {
    "academicLevels": [
      "Undergraduate",
      "Recent graduate",
      "Degree holder"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "c40b9181817f21e09806593675464fac24af9064d7255f275485e14e0731a168": {
    "academicLevels": [
      "Undergraduate",
      "Recent graduate",
      "Degree holder"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "f905319fe370f3ade24c0c645251169154f893d2b545097932299093f18ebf8a": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's",
      "Professional"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "All nationalities",
      "Country-specific criteria"
    ]
  },
  "0b378ff7e800469d6435a9013b2cf973f78684929eebb1bd591686569be8b42c": {
    "academicLevels": [
      "Degree holder",
      "Graduate",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Health & medicine",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals"
    ]
  },
  "136aea10babc6054392ad73716c5d48b295cd0f919c8bfeef452c25bdef96212": {
    "academicLevels": [
      "Degree holder",
      "Graduate",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Natural sciences",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "57755b20533a0233e73f2c2dc95d0a10d27b8f25d9467f940d362c5039f13cd4": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Education"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "78361042a1b3fea8ee550edbe048a7b60424de879590b96e4f56c92896a0aa0f": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Health & medicine",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "U.S. permanent residents"
    ]
  },
  "1e60b69d98b87f3026a2b6525b300f11ea66d291932f9925e568a9939286f99e": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "Social sciences & policy",
      "Business & law"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "f8cd7403f2dd9c025b921206a16f4c624114be3f97836d1747d5334448c15048": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Mathematics",
      "Social sciences & policy"
    ],
    "citizenship": [
      "Other / not listed"
    ]
  },
  "b4a54361c1d56c2f1c2e86ad6b770e54110ef2b8ff34f0fec02d7fb9acc88414": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder"
    ],
    "disciplines": [
      "STEM",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "All nationalities",
      "Country-specific criteria"
    ]
  },
  "ad8114e911e58d705a1e58f3ca7f68c7bee8f962791b7e85577c0ef792f907a0": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder"
    ],
    "disciplines": [
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "All nationalities",
      "Country-specific criteria"
    ]
  },
  "7f0a3c014a03cc13d6245b91f228be7943d2bd6f94ed43c0cc8453e7626237f1": {
    "academicLevels": [
      "Graduate",
      "Master's",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents",
      "DACA / undocumented"
    ]
  },
  "2fbea033f67b68dfed3927530ab4975f9ea6d2cf0ccf62b5d3cfd486cf497ee8": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "Social sciences & policy",
      "Business & law"
    ],
    "citizenship": [
      "U.S. citizens"
    ]
  },
  "08cf4640bdaed49306424b98ffc0c90892b1e7a6f8789b6058f04a3b8eaa8f12": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents",
      "DACA / undocumented",
      "Country-specific criteria"
    ]
  },
  "7ad6b122ea21016f0246921ec157dad6ca0d88288534856b074b4a0351e95ff5": {
    "academicLevels": [
      "Degree holder",
      "Graduate",
      "Master's",
      "Professional"
    ],
    "disciplines": [
      "Social sciences & policy"
    ],
    "citizenship": [
      "Other / not listed"
    ]
  },
  "0bca4749c85e3ed9f44b6957dd4d3391f6c49e203a49ee4435468b296d66f392": {
    "academicLevels": [
      "Graduate",
      "Master's",
      "Professional"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Business & law",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens",
      "DACA / undocumented"
    ]
  },
  "a9c7602fea7ec4a26973af6bfb08aefd8687de36f06bb2ac120be2bc949e62b9": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "All nationalities",
      "Country-specific criteria"
    ]
  },
  "a0f3a06a47f63f1113b8d2886a7a5f1309810e91d515a4c4cf713047aecb8867": {
    "academicLevels": [
      "Undergraduate",
      "Graduate",
      "Master's",
      "Doctoral"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences"
    ],
    "citizenship": [
      "U.S. citizens",
      "Country-specific criteria"
    ]
  },
  "1af89b3300ada8d23e168c38d04a5dcaa84ebe1a704ea5c028111c34f9b01041": {
    "academicLevels": [
      "Degree holder",
      "Graduate",
      "Professional"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents",
      "DACA / undocumented",
      "New American criteria"
    ]
  },
  "3ebfeedfba6bc8e908853f9faad6bd79471823e3b10b566460f4568e8656f786": {
    "academicLevels": [
      "Undergraduate",
      "Recent graduate"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. permanent residents"
    ]
  },
  "56b21718c3852628aab23d49cd11c71bfab3bfe350ea908c02954727f2a1b1b8": {
    "academicLevels": [
      "Undergraduate",
      "Graduate",
      "Master's",
      "Professional"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "Other / not listed"
    ]
  },
  "f3646194d760aaf49cdf724aca333c865ecaf227c31e5ccb851cb70263253e75": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Engineering",
      "Computing & data",
      "Mathematics",
      "Natural sciences",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Arts",
      "Business & law",
      "Health & medicine",
      "Education",
      "Multiple fields (check courses)"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "Country-specific criteria"
    ]
  },
  "f9529b39563a81fc2f52c26bdb60f082872ea5c3a4ee029bf61130b61387a6c5": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "STEM",
      "Environment & earth sciences",
      "Social sciences & policy",
      "Health & medicine"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "U.S. permanent residents"
    ]
  },
  "10e7ce20d31d4ce5c8b9c19fc88ed3cb01842c29eaee6115fd119d39b27707ac": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "U.S. nationals",
      "U.S. permanent residents",
      "DACA / undocumented"
    ]
  },
  "8662474c2f8ddd4c200e58e794518ce83c3e7964e2b6299b1d017d51523a6503": {
    "academicLevels": [
      "Undergraduate"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "All nationalities"
    ]
  },
  "2f5b0f811d64f717b8432a91b7be5350ad88ccc9c84ab4613d23a7f17743bd82": {
    "academicLevels": [
      "Undergraduate",
      "Degree holder",
      "Graduate",
      "Master's"
    ],
    "disciplines": [
      "No field restriction"
    ],
    "citizenship": [
      "U.S. citizens",
      "Country-specific criteria"
    ]
  }
};

export function directoryCategoryReviewKey(awardId: string, facts: ReviewFacts): string {
 return createHash("sha256").update(JSON.stringify([awardId, facts.academicLevels, facts.disciplines, facts.citizenship, facts.eligibility])).digest("hex");
}

export function getReviewedAwardDirectoryCategories(awardId: string, facts: ReviewFacts) {
 const reviewed = reviews[directoryCategoryReviewKey(awardId, facts)];
 return reviewed ? { academicLevels: [...reviewed.academicLevels], disciplines: [...reviewed.disciplines], citizenship: [...reviewed.citizenship] } : undefined;
}
