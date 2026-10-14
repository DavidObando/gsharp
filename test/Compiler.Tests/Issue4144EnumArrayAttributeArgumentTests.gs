// <copyright file="Issue4144EnumArrayAttributeArgumentTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests

import GSharp.Compiler
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import System.Text.RegularExpressions
import Xunit

/// Issue #4144: `@E([]Status{Status.Active})` — a 1-D array of an ENUM
/// as an attribute argument — was rejected by `GS0202`, whose own
/// message ("primitive, string, typeof, enum, or 1-D array thereof") says
/// this exact shape is permitted. ECMA-335 II.23.3 allows it and `csc`
/// accepts the identical C# shape with no diagnostic.
/// @remarks <b>Scope, measured rather than assumed.</b> The issue named the
/// same-compilation case only and explicitly left open whether an IMPORTED
/// enum's array behaved the same way. Measured on `origin/main`: BOTH
/// fail, for two entirely unrelated reasons.
///
/// <b>Same-compilation: the #3684/#4073 erasure family.</b> A
/// same-compilation enum has no (cref:Type) (`ClrType`) until it
/// is emitted, and the array-argument binder gated on
/// `bound.Type.ClrType` being a non-null, rank-1 array — so
/// `[]Status{...}`'s array type, itself built from the elementless
/// enum, read as null and the whole array was rejected before any element
/// was even looked at. This is exactly the shape #4097's SCALAR enum fix
/// already had to look past (a same-compilation enum's underlying type is
/// always `int32`), just never extended to the array binder.
///
/// <b>Imported: a plain coercion bug, unrelated to erasure.</b>
/// `[]DayOfWeek{...}`'s array type has a perfectly real, non-null
/// `ClrType` (`System.DayOfWeek[]`) and passed the old gate — the
/// failure was one step later. The constant-array coercion converted the
/// bound element (already the boxed UNDERLYING primitive, per #4097) to the
/// enum's underlying type again via `Convert.ChangeType`, which is a
/// no-op that leaves a boxed `int`; `Array.SetValue` then refused
/// to store an `int` into a `DayOfWeek[]` slot
/// (`InvalidCastException: "Object cannot be stored in an array of this
/// type."`), caught by a blanket `catch` and reported as the
/// misleading `GS0202`. Fixed with `Enum.ToObject`, which produces
/// the genuine boxed enum instance the array slot needs.
///
/// <b>Reified, not merely accepted.</b> Compiling clean is not proof
/// enough for this class of bug (an attribute or type serialising to a name
/// that RESOLVES, just to the wrong thing) — both rows are read back through
/// a (cref:MetadataLoadContext) and their array VALUES are asserted,
/// not merely their shape.
open class Issue4144EnumArrayAttributeArgumentTests {
    @Fact
    func ASameCompilationEnumArrayAttributeArgument_CompilesAndReifiesCorrectly() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4144_samecomp_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", SameCompilationSource, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Length == 0,
                (
                    `a same-compilation enum-array attribute argument must compile clean. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
            Assert.True(File.Exists(appPath), (`must produce an assembly. Log:
` + "$log"))
            IlVerifier.Verify(appPath)
            // `CustomAttributeTypedArgument.Value` always reads back an
            // enum-typed argument as its UNDERLYING primitive — a
            // documented quirk of the reflection API, not a G# defect (a
            // real, non-reflection-only enum cannot be boxed by an MLC, so
            // this is what .NET itself hands back regardless of how the
            // blob was written). `ArgumentType` is the half that proves the
            // metadata names what the source wrote: it must resolve to
            // `P.Status[]`, not `System.Int32[]` or anything else that
            // happens to also read back.
            let (argumentType, values) = ReadEnumArrayArgument(appPath, "Target")
            Assert.Equal("P.Status[]", argumentType)
            Assert.Equal([]object{0, 1}, values)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Fact
    func AnImportedEnumArrayAttributeArgument_CompilesAndReifiesCorrectly() {
        let tempDir = Directory.CreateTempSubdirectory("gs_4144_imported_").FullName
        try {
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", ImportedSource, appPath, "/target:exe")
            let ids = ErrorIds(log)
            Assert.True(
                ids.Length == 0,
                (
                    `an imported enum-array attribute argument must compile clean. Reported: [` +
                        "${string.Join(", ", ids)}" +
                        `]
Log:
` +
                        "$log"
                )
            )
            Assert.True(File.Exists(appPath), (`must produce an assembly. Log:
` + "$log"))
            IlVerifier.Verify(appPath)
            // Same underlying-value caveat as the same-compilation row
            // above; `ArgumentType` must resolve to `System.DayOfWeek[]`.
            let (argumentType, values) = ReadEnumArrayArgument(appPath, "Target")
            Assert.Equal("System.DayOfWeek[]", argumentType)
            Assert.Equal([]object{1, 5}, values)
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    @Theory
    @InlineData(false, false)
    @InlineData(false, true)
    @InlineData(true, false)
    @InlineData(true, true)
    func NestedEnumArrayInObjectArray_PreservesMetadataIdentity(imported bool, empty bool) {
        let tempDir = Directory.CreateTempSubdirectory("gs_4214_nested_enum_").FullName
        try {
            let elementType = if imported {
                "DayOfWeek"
            } else {
                "Status"
            }
            let elements = if empty {
                string.Empty
            } else {
                (
                    if imported {
                        "DayOfWeek.Monday, DayOfWeek.Friday"
                    } else {
                        "Status.Active, Status.Retired"
                    }
                )
            }
            let source = (`package P
import System
enum Status { Active, Retired }
class EAttribute(Values object) : Attribute {}
@E([]object{[]` + "$elementType" + `{ ` + "$elements" + ` } })
class Target {}
Console.WriteLine("ok")`)
            let appPath = Path.Combine(tempDir, "P.dll")
            let log = Compile(tempDir, "App.gs", source, appPath, "/target:exe")
            Assert.True(ErrorIds(log).Length == 0, log)
            Assert.True(File.Exists(appPath), log)
            IlVerifier.Verify(appPath)
            let (argumentType, values) = ReadEnumArrayArgument(appPath, "Target", nested: true)
            Assert.Equal(
                if imported {
                    "System.DayOfWeek[]"
                } else {
                    "P.Status[]"
                },
                argumentType
            )
            Assert.Equal(
                if empty {
                    Array.Empty[object]()
                } else {
                    (
                        if imported {
                            []object{1, 5}
                        } else {
                            []object{0, 1}
                        }
                    )
                },
                values
            )
        } finally {
            Directory.Delete(tempDir, recursive: true)
        }
    }

    shared {
        private const SameCompilationSource string = `package P
import System

enum Status {
    Active,
    Retired
}

class EAttribute(Kinds []Status) : Attribute {
}

@E([]Status{Status.Active, Status.Retired})
class Target {
}

Console.WriteLine("ok")`

        private const ImportedSource string = `package P
import System

class EAttribute(Kinds []DayOfWeek) : Attribute {
}

@E([]DayOfWeek{DayOfWeek.Monday, DayOfWeek.Friday})
class Target {
}

Console.WriteLine("ok")`

        private func ReadEnumArrayArgument(assemblyPath string, typeName string, nested bool = false)(
            ArgumentType string,
            Values[]object
        ) {
            let paths = List[string](TrustedPlatformAssemblies()){assemblyPath}
            using let context = MetadataLoadContext(PathAssemblyResolver(paths.Distinct(StringComparer.Ordinal)))
            let assembly = context.LoadFromAssemblyPath(assemblyPath)
            let target = assembly.GetTypes().Single((candidate Type) -> candidate.Name == typeName)
            let attribute = target.GetCustomAttributesData().Single(
                (candidate CustomAttributeData) -> candidate.AttributeType.Name == "EAttribute"
            )
            var arrayArgument = attribute.ConstructorArguments.Single()
            if nested {
                arrayArgument = Assert.Single(
                    Assert.IsAssignableFrom[IReadOnlyCollection[CustomAttributeTypedArgument]](arrayArgument.Value)
                )
            }
            let elements = Assert.IsAssignableFrom[IReadOnlyCollection[CustomAttributeTypedArgument]](
                arrayArgument.Value
            )
            let values = elements.Select((element CustomAttributeTypedArgument) -> element.Value!!).ToArray()
            return (arrayArgument.ArgumentType.FullName!!, values)
        }

        private func ErrorIds(log string)[]string -> Regex
            .Matches(log, "error (GS[0-9]{4})")
            .Select((match Match) -> match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .ToArray()

        private func Compile(dir string, fileName string, source string, outPath string, extra ...string) string {
            let srcPath = Path.Combine(dir, fileName)
            File.WriteAllText(srcPath, source)
            let args = List[string]{"/out:" + outPath, "/targetframework:net10.0"}
            args.AddRange(extra)
            for reference in TrustedPlatformAssemblies() {
                args.Add("/reference:" + reference)
            }
            args.Add(srcPath)
            using let compileOut = StringWriter()
            using let compileErr = StringWriter()
            let prevOut = Console.Out
            let prevErr = Console.Error
            Console.SetOut(compileOut)
            Console.SetError(compileErr)
            try {
                Program.Main(args.ToArray())
            } finally {
                Console.SetOut(prevOut)
                Console.SetError(prevErr)
            }
            return compileOut.ToString() + compileErr.ToString()
        }

        private func TrustedPlatformAssemblies() IEnumerable[string] {
            let tpa string? = cast[string](AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!!)
            return tpa!!.Split(Path.PathSeparator)
        }
    }
}
