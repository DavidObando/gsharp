// <copyright file="Issue3633AttributeArrayMlcTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import Xunit

/// Issue #3633: an attribute array whose element type resolves through the
/// MetadataLoadContext (a `/reference:` compile — the SDK/gsgen path)
/// crashed the whole compilation with
/// `ArgumentException: Type must be a type provided by the runtime
/// (Parameter 'elementType')`: the binder built the constant-container
/// array via `Array.CreateInstance` with the MLC element type. This was
/// the gsgen `GS9200` wall on migrated Core.Tests in the selfmig
/// nightly. The container now uses a runtime-equivalent element type (the
/// blob is written from the signature's element type, so the container shape
/// is immaterial).
open class Issue3633AttributeArrayMlcTests {
    @Fact
    func ImportedEnumArrayAttributeArgument_CompilesUnderRefPack() {
        XunitAssertOverloadResolutionTests.AssertGsCompilesCleanlyAgainstRefPack(`package P

import System

class DaysAttribute : Attribute {
    init(days []DayOfWeek) {
    }
}

@Days([]DayOfWeek{DayOfWeek.Monday, DayOfWeek.Friday})
class Holder {
}`)
    }

    @Fact
    func PrimitiveAndStringArrayAttributeArguments_CompileUnderRefPack() {
        XunitAssertOverloadResolutionTests.AssertGsCompilesCleanlyAgainstRefPack(`package P

import System

class TagsAttribute : Attribute {
    init(tags []string, codes []int32) {
    }
}

@Tags([]string{"a", "b"}, []int32{1, 2})
class Holder {
}`)
    }
}
