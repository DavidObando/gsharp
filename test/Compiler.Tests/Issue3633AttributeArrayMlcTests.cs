// <copyright file="Issue3633AttributeArrayMlcTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

namespace GSharp.Compiler.Tests;

/// <summary>
/// Issue #3633: an attribute array whose element type resolves through the
/// MetadataLoadContext (a <c>/reference:</c> compile — the SDK/gsgen path)
/// crashed the whole compilation with
/// <c>ArgumentException: Type must be a type provided by the runtime
/// (Parameter 'elementType')</c>: the binder built the constant-container
/// array via <c>Array.CreateInstance</c> with the MLC element type. This was
/// the gsgen <c>GS9200</c> wall on migrated Core.Tests in the selfmig
/// nightly. The container now uses a runtime-equivalent element type (the
/// blob is written from the signature's element type, so the container shape
/// is immaterial).
/// </summary>
public class Issue3633AttributeArrayMlcTests
{
    [Fact]
    public void ImportedEnumArrayAttributeArgument_CompilesUnderRefPack()
    {
        XunitAssertOverloadResolutionTests.AssertGsCompilesCleanlyAgainstRefPack("""
            package P

            import System

            class DaysAttribute : Attribute {
                init(days []DayOfWeek) {
                }
            }

            @Days([]DayOfWeek{DayOfWeek.Monday, DayOfWeek.Friday})
            class Holder {
            }
            """);
    }

    [Fact]
    public void PrimitiveAndStringArrayAttributeArguments_CompileUnderRefPack()
    {
        XunitAssertOverloadResolutionTests.AssertGsCompilesCleanlyAgainstRefPack("""
            package P

            import System

            class TagsAttribute : Attribute {
                init(tags []string, codes []int32) {
                }
            }

            @Tags([]string{"a", "b"}, []int32{1, 2})
            class Holder {
            }
            """);
    }
}
