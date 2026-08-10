// <copyright file="Issue2895InheritedFieldDeclaringTypeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using Xunit;

namespace GSharp.Compiler.Tests.Emit;

/// <summary>
/// Issue #2895: inherited field references from generic derived classes must
/// name the field's declaring base type, not the generic receiver type.
/// </summary>
public class Issue2895InheritedFieldDeclaringTypeTests
{
    private static readonly IReadOnlyDictionary<ushort, OpCode> OpCodesByValue =
        typeof(OpCodes)
            .GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(field => field.FieldType == typeof(OpCode))
            .Select(field => (OpCode)field.GetValue(null)!)
            .ToDictionary(opCode => unchecked((ushort)opCode.Value));

    [Fact]
    public void UnqualifiedAccessesInsideGenericDerivedUseNonGenericBase()
    {
        const string source = """
            package Issue2895Unqualified
            import System

            data struct Payload(Code int32)

            open class Base {
                internal var number int32 = 11
                internal var payload Payload = Payload(44)
            }

            class Derived[T] : Base {
                func Read() int32 { return number }
                func Write() int32 {
                    number = 22
                    return number
                }
                func Compound() int32 {
                    number += 11
                    return number
                }
                func ReadPayload() int32 { return payload.Code }
            }

            let value = Derived[string]()
            Console.WriteLine(value.Read())
            Console.WriteLine(value.Write())
            Console.WriteLine(value.Compound())
            Console.WriteLine(value.ReadPayload())
            """;

        using var artifact = Compile(nameof(UnqualifiedAccessesInsideGenericDerivedUseNonGenericBase), source);
        AssertFieldOwners(artifact.Assembly, "number", "Base", minimumReferences: 6);
        AssertFieldOwners(artifact.Assembly, "payload", "Base", minimumReferences: 1);
        AssertRuns(artifact.Path, "11\n22\n33\n44\n");
    }

    [Fact]
    public void ExplicitReceiverWritesUseNonGenericBase()
    {
        const string source = """
            package Issue2895Explicit
            import System

            open class Base {
                internal var explicitValue int32
            }

            class Derived[T] : Base {
            }

            class Holder {
                internal var child Derived[string] = Derived[string]()

                func Write() int32 {
                    child.explicitValue = 67
                    return child.explicitValue
                }
            }

            let top = Derived[string]()
            top.explicitValue = 55
            Console.WriteLine(top.explicitValue)

            func Run() int32 {
                let local = Derived[int32]()
                local.explicitValue = 66
                return local.explicitValue
            }

            Console.WriteLine(Run())
            Console.WriteLine(Holder().Write())
            """;

        using var artifact = Compile(nameof(ExplicitReceiverWritesUseNonGenericBase), source);
        AssertFieldOwners(artifact.Assembly, "explicitValue", "Base", minimumReferences: 6);
        AssertRuns(artifact.Path, "55\n66\n67\n");
    }

    [Fact]
    public void ObjectInitializerWriteUsesNonGenericBase()
    {
        const string source = """
            package Issue2895Initializer
            import System

            open class Base {
                internal var initializedValue int32
            }

            class Derived[T] : Base {
            }

            let value = Derived[string]() { initializedValue = 77 }
            Console.WriteLine(value.initializedValue)
            """;

        using var artifact = Compile(nameof(ObjectInitializerWriteUsesNonGenericBase), source);
        AssertFieldOwners(artifact.Assembly, "initializedValue", "Base", minimumReferences: 2);
        AssertRuns(artifact.Path, "77\n");
    }

    [Fact]
    public void MultiLevelAndNestedGenericDerivedUseTheirDeclaringBases()
    {
        const string source = """
            package Issue2895Shapes
            import System
            import System.Collections.Generic

            open class Root {
                internal var deepValue int32 = 88
            }

            open class Mid[T] : Root {
            }

            class Deep[T] : Mid[List[T]] {
                func Read() int32 { return deepValue }
            }

            open class NestedBase {
                internal var nestedValue int32 = 99
            }

            class Container {
                class Nested[T] : NestedBase {
                    func Read() int32 { return nestedValue }
                }
            }

            Console.WriteLine(Deep[string]().Read())
            Console.WriteLine(Container.Nested[string]().Read())
            """;

        using var artifact = Compile(nameof(MultiLevelAndNestedGenericDerivedUseTheirDeclaringBases), source);
        AssertFieldOwners(artifact.Assembly, "deepValue", "Root", minimumReferences: 1);
        AssertFieldOwners(artifact.Assembly, "nestedValue", "NestedBase", minimumReferences: 1);
        AssertRuns(artifact.Path, "88\n99\n");
    }

    [Fact]
    public void GenericBaseShapesUseConstructedDeclaringBase()
    {
        const string source = """
            package Issue2895GenericBases
            import System
            import System.Collections.Generic

            data struct Payload(Code int32)

            open class GenericBase[T] {
                internal var genericValue T
            }

            class Forwarded[T] : GenericBase[T] {
                func Set(value T) { genericValue = value }
                func Read() T { return genericValue }
            }

            class Substituted[T] : GenericBase[int32] {
                func Set(value int32) { genericValue = value }
                func Read() int32 { return genericValue }
            }

            class NestedSubstitution[T] : GenericBase[List[T]] {
                func Set(value List[T]) { genericValue = value }
                func Read() List[T] { return genericValue }
            }

            let forwarded = Forwarded[Payload]()
            forwarded.Set(Payload(11))
            Console.WriteLine(forwarded.Read().Code)

            let substituted = Substituted[string]()
            substituted.Set(22)
            Console.WriteLine(substituted.Read())

            let values = List[string]()
            values.Add("item")
            let nested = NestedSubstitution[string]()
            nested.Set(values)
            Console.WriteLine(nested.Read().Count)
            """;

        using var artifact = Compile(nameof(GenericBaseShapesUseConstructedDeclaringBase), source);
        AssertFieldOwners(artifact.Assembly, "genericValue", "GenericBase`1", minimumReferences: 6);
        AssertRuns(artifact.Path, "11\n22\n1\n");
    }

    [Fact]
    public void InheritedStaticFieldRemainsValid()
    {
        const string source = """
            package Issue2895StaticGuard
            import System

            open class Base {
                shared {
                    internal var sharedValue int32
                }
            }

            class Derived[T] : Base {
            }

            Derived[string].sharedValue = 44
            Console.WriteLine(Derived[string].sharedValue)
            """;

        using var artifact = Compile(nameof(InheritedStaticFieldRemainsValid), source);
        AssertFieldOwners(artifact.Assembly, "sharedValue", "Base", minimumReferences: 2);
        AssertRuns(artifact.Path, "44\n");
    }

    [Fact]
    public void InheritedFieldAddressRemainsValid()
    {
        const string source = """
            package Issue2895AddressGuard
            import System

            open class Base {
                internal var addressValue int32
                func Read() int32 { return addressValue }
            }

            class Derived[T] : Base {
            }

            func SetAddress(out value int32) { value = 33 }

            let value = Derived[string]()
            SetAddress(&value.addressValue)
            Console.WriteLine(value.Read())
            """;

        using var artifact = Compile(nameof(InheritedFieldAddressRemainsValid), source);
        AssertFieldOwners(artifact.Assembly, "addressValue", "Base", minimumReferences: 2);
        AssertRuns(artifact.Path, "33\n");
    }

    private static Artifact Compile(string name, string source)
    {
        var directory = Path.Combine(AppContext.BaseDirectory, nameof(Issue2895InheritedFieldDeclaringTypeTests), name);
        if (Directory.Exists(directory))
        {
            Directory.Delete(directory, recursive: true);
        }

        Directory.CreateDirectory(directory);
        var sourcePath = Path.Combine(directory, "test.gs");
        var assemblyPath = Path.Combine(directory, "test.dll");
        File.WriteAllText(sourcePath, source);

        var exitCode = Program.Main(new[]
        {
            "/out:" + assemblyPath,
            "/target:exe",
            "/targetframework:net10.0",
            "/nowarn:GS9100",
            sourcePath,
        });
        Assert.Equal(0, exitCode);

        var assembly = Assembly.Load(File.ReadAllBytes(assemblyPath));
        _ = assembly.GetTypes();
        return new Artifact(directory, assemblyPath, assembly);
    }

    private static void AssertFieldOwners(
        Assembly assembly,
        string fieldName,
        string expectedOwner,
        int minimumReferences)
    {
        var fields = GetReferencedFields(assembly)
            .Where(field => field.Name == fieldName)
            .ToArray();

        Assert.True(
            fields.Length >= minimumReferences,
            $"Expected at least {minimumReferences} references to '{fieldName}', found {fields.Length}.");
        Assert.All(fields, field => Assert.Equal(expectedOwner, field.DeclaringType!.Name));
    }

    private static IEnumerable<FieldInfo> GetReferencedFields(Assembly assembly)
    {
        foreach (var type in assembly.GetTypes())
        {
            foreach (var method in type.GetMethods(
                BindingFlags.Public
                | BindingFlags.NonPublic
                | BindingFlags.Static
                | BindingFlags.Instance
                | BindingFlags.DeclaredOnly))
            {
                var body = method.GetMethodBody();
                var il = body?.GetILAsByteArray();
                if (il == null)
                {
                    continue;
                }

                var offset = 0;
                while (offset < il.Length)
                {
                    var value = (ushort)il[offset++];
                    if (value == 0xfe)
                    {
                        value = (ushort)(0xfe00 | il[offset++]);
                    }

                    var opCode = OpCodesByValue[value];
                    if (opCode.OperandType == OperandType.InlineField)
                    {
                        var token = BitConverter.ToInt32(il, offset);
                        yield return method.Module.ResolveField(
                            token,
                            type.IsGenericType ? type.GetGenericArguments() : null,
                            method.IsGenericMethod ? method.GetGenericArguments() : null)!;
                    }

                    offset += OperandSize(opCode.OperandType, il, offset);
                }
            }
        }
    }

    private static int OperandSize(OperandType operandType, byte[] il, int offset) => operandType switch
    {
        OperandType.InlineNone => 0,
        OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
        OperandType.InlineVar => 2,
        OperandType.InlineI
            or OperandType.InlineBrTarget
            or OperandType.InlineField
            or OperandType.InlineMethod
            or OperandType.InlineSig
            or OperandType.InlineString
            or OperandType.InlineTok
            or OperandType.InlineType
            or OperandType.ShortInlineR => 4,
        OperandType.InlineI8 or OperandType.InlineR => 8,
        OperandType.InlineSwitch => 4 + (BitConverter.ToInt32(il, offset) * 4),
        _ => throw new InvalidOperationException($"Unsupported IL operand type: {operandType}."),
    };

    private static void AssertRuns(string assemblyPath, string expectedOutput)
    {
        var startInfo = new ProcessStartInfo("dotnet")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(assemblyPath);

        using var process = Process.Start(startInfo)!;
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(30_000))
        {
            process.Kill(entireProcessTree: true);
            throw new Xunit.Sdk.XunitException("Child process timed out.");
        }

        var stdout = stdoutTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
        var stderr = stderrTask.GetAwaiter().GetResult().ReplaceLineEndings(Environment.NewLine);
        Assert.True(
            process.ExitCode == 0,
            $"Child exited {process.ExitCode}.\nstdout:\n{stdout}\nstderr:\n{stderr}");
        Assert.Equal(expectedOutput, stdout);
        Assert.Equal(string.Empty, stderr);
    }

    private sealed class Artifact : IDisposable
    {
        public Artifact(string directory, string path, Assembly assembly)
        {
            Directory = directory;
            Path = path;
            Assembly = assembly;
        }

        public string Directory { get; }

        public string Path { get; }

        public Assembly Assembly { get; }

        public void Dispose()
        {
            try
            {
                System.IO.Directory.Delete(Directory, recursive: true);
            }
            catch (IOException)
            {
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
    }
}
