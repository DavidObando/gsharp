package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import System.Runtime.InteropServices
import System.Text
import System.Text.RegularExpressions
import Xunit

class Issue6072ReturnMarshalAsDriverTests {
    @Theory
    @InlineData("DllImport", "U1", 4)
    @InlineData("DllImport", "I1", 3)
    @InlineData("DllImport", "Bool", 2)
    @InlineData("DllImport", "VariantBool", 37)
    @InlineData("LibraryImport", "U1", 4)
    @InlineData("LibraryImport", "I1", 3)
    @InlineData("LibraryImport", "Bool", 2)
    @InlineData("LibraryImport", "VariantBool", 37)
    func BoolOverride_ReachesReturnRowAndRuntimeReflection(importName string, form string, token int32) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let source = `import System
import System.ComponentModel
import System.Diagnostics.CodeAnalysis
import System.Reflection
import System.Runtime.InteropServices
class Native {
    shared {
        @` + importName + `("unused6072")
        @return:MarshalAs(UnmanagedType.` + form + `)
        @return:Description("result")
        public func Probe(@MarshalAs(UnmanagedType.U1) flag bool) bool;
        @` + importName + `("unused6072")
        public func DefaultBool() bool;
        @return:MaybeNull
        public func Managed() string? -> nil
    }
}
let type = typeof(Native)
let method = type.GetMethod("Probe")!!
Console.Write(method.ReturnParameter.GetCustomAttribute[MarshalAsAttribute]().Value.ToString())
Console.Write("|")
Console.Write(method.GetParameters()[0].GetCustomAttribute[MarshalAsAttribute]().Value.ToString())
Console.Write("|")
Console.Write(method.ReturnParameter.GetCustomAttribute[DescriptionAttribute]().Description)
Console.Write("|")
Console.Write(type.GetMethod("DefaultBool")!!.ReturnParameter.GetCustomAttribute[MarshalAsAttribute]() == nil)
Console.Write("|")
Console.Write(type.GetMethod("Managed")!!.ReturnParameter.GetCustomAttribute[MaybeNullAttribute]() != nil)
`
        let dll = fixture.Compile(source, "return6072", true, "/deterministic+", "/debug:none")
        let bytes = File.ReadAllBytes(dll)
        fixture.Compile(source, "return6072", true, "/deterministic+", "/debug:none")
        Assert.Equal(bytes, File.ReadAllBytes(dll))
        IlVerifier.Verify(dll)
        using let stream = File.OpenRead(dll)
        using let pe = PEReader(stream)
        let md = pe.GetMetadataReader()
        let methods = md.MethodDefinitions.Select(md.GetMethodDefinition).ToArray()
        let probe = methods.Single((m MethodDefinition) -> md.GetString(m.Name) == "Probe")
        let rows = probe.GetParameters().Select(md.GetParameter).ToArray()
        Assert.Equal([]int32{0, 1}, rows.Select((p Parameter) -> p.SequenceNumber).ToArray())
        AssertMarshal(md, rows[0], []uint8{uint8(token)})
        AssertMarshal(md, rows[1], []uint8{uint8(UnmanagedType.U1)})
        let nativeType = EmittedFixture.Load(dll).GetTypes().Single((t Type) -> t.Name == "Native")
        let reflected = nativeType.GetMethod("Probe")!!
        Assert.Equal((UnmanagedType(token)), reflected.ReturnParameter.GetCustomAttribute[MarshalAsAttribute]().Value)
        Assert.Single(
            reflected.ReturnParameter.GetCustomAttributesData(),
            (a CustomAttributeData) -> a.AttributeType == typeof(MarshalAsAttribute)
        )
        if importName == "LibraryImport" {
            let inner = methods.Single((m MethodDefinition) -> md.GetString(m.Name) == "<Probe>g__PInvoke|0_0")
            let innerRows = inner.GetParameters().Select(md.GetParameter).ToArray()
            Assert.Equal([]int32{0, 1}, innerRows.Select((p Parameter) -> p.SequenceNumber).ToArray())
            AssertMarshal(md, innerRows[0], []uint8{uint8(token)})
            AssertMarshal(md, innerRows[1], []uint8{uint8(UnmanagedType.U1)})
            let reflectedInner = nativeType.GetMethod(
                "<Probe>g__PInvoke|0_0",
                BindingFlags.NonPublic | BindingFlags.Static
            )!!
            Assert.Equal(
                UnmanagedType(token),
                reflectedInner.ReturnParameter.GetCustomAttribute[MarshalAsAttribute]().Value
            )
        }
        let defaults = methods.Where((m MethodDefinition) -> md.GetString(m.Name).Contains("DefaultBool")).ToArray()
        Assert.Equal(
            if importName == "LibraryImport" {
                2
            } else {
                1
            },
            defaults.Length
        )
        Assert.All(defaults, (m MethodDefinition) -> Assert.Empty(m.GetParameters()))
        Assert.Equal(Encoding.UTF8.GetBytes(form + "|U1|result|True|True"), fixture.RunBytes(dll))
    }

    @Theory
    @InlineData("DllImport", "LPWStr", "string", "15")
    @InlineData("DllImport", "LPArray, ArraySubType: UnmanagedType.I4, SizeConst: 3", "[]int32", "2A070003")
    @InlineData("LibraryImport", "LPArray, SizeParamIndex: 1", "[]int32", "2A5001")
    @InlineData("DllImport", "SafeArray, SafeArraySubType: VarEnum.VT_I4", "[]int32", "1D03")
    @InlineData("LibraryImport", "SafeArray, SafeArraySubType: VarEnum.VT_I4", "[]int32", "1D03")
    func StringAndArrayOverrides_UseTheSharedDescriptor(importName string, form string, type string, hex string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let dll = fixture.Compile(
            "import System.Runtime.InteropServices\n@" +
                importName +
                "(\"unused6072\")\n" +
                "@return:MarshalAs(UnmanagedType." +
                form +
                ")\nfunc Probe(x int32, count int32) " +
                type +
                ";",
            "descriptor6072",
            false
        )
        IlVerifier.Verify(dll)
        using let stream = File.OpenRead(dll)
        using let pe = PEReader(stream)
        let md = pe.GetMetadataReader()
        let methods = md
            .MethodDefinitions
            .Select(md.GetMethodDefinition)
            .Where((m MethodDefinition) -> md.GetString(m.Name).Contains("Probe"))
            .ToArray()
        Assert.Equal(
            if importName == "LibraryImport" {
                2
            } else {
                1
            },
            methods.Length
        )
        for method in methods {
            let rows = method.GetParameters().Select(md.GetParameter).ToArray()
            Assert.Equal([]int32{0, 1, 2}, rows.Select((p Parameter) -> p.SequenceNumber).ToArray())
            AssertMarshal(md, rows[0], Convert.FromHexString(hex))
        }
        let reflected = EmittedFixture
            .Load(dll)
            .GetTypes()
            .SelectMany((t Type) -> t.GetMethods())
            .Single((m MethodInfo) -> m.Name == "Probe")
            .ReturnParameter
            .GetCustomAttribute[MarshalAsAttribute]()
        Assert.Equal(Convert.FromHexString(hex)[0], uint8(reflected.Value))
        if form.Contains("SizeParamIndex") {
            Assert.Equal(int16(1), reflected.SizeParamIndex)
        }
        if form.Contains("SizeConst") {
            Assert.Equal(3, reflected.SizeConst)
            Assert.Equal(UnmanagedType.I4, reflected.ArraySubType)
        }
        if form.Contains("SafeArraySubType") {
            let control = fixture.CompileCSharp(`using System.Runtime.InteropServices;
public static class NativeControl {
    [DllImport("unused6072")]
    [return: MarshalAs(UnmanagedType.SafeArray, SafeArraySubType = VarEnum.VT_I4)]
    public static extern int[] Probe();
}`, "safeArrayControl6072")
            let expected = EmittedFixture.Load(control).GetType("NativeControl")!!.GetMethod("Probe")!!
                .ReturnParameter
                .GetCustomAttribute[MarshalAsAttribute]()
                .SafeArraySubType
            Assert.Equal(expected, reflected.SafeArraySubType)
        }
    }

    @Theory
    @InlineData("DllImport", "U1", "string", "GS0358")
    @InlineData("LibraryImport", "LPWStr", "string", "GS0360")
    @InlineData("DllImport", "CustomMarshaler", "bool", "GS0357")
    @InlineData("DllImport", "ByValArray, SizeConst: 4", "[]int32", "GS0360")
    @InlineData("DllImport", "ByValTStr, SizeConst: 4", "string", "GS0360")
    @InlineData("DllImport", "LPArray", "[]int32", "GS0359")
    @InlineData("LibraryImport", "U1", "void", "GS0358")
    func InvalidReturnOverride_ReportsLocatedDiagnostic(importName string, form string, type string, id string) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let annotation = "@return:MarshalAs(UnmanagedType." + form + ")"
        let importAnnotation = "@" +
            importName +
            `("unused6072"` +
            (
            if importName == "LibraryImport" && type == "string" {
                ", StringMarshalling: StringMarshalling.Utf16"
            } else {
                ""
            }
        ) +
            ")"
        let (code, output) = fixture.TryCompile(
            "import System.Runtime.InteropServices\n" +
                importAnnotation +
                "\n" +
                annotation +
                "\nfunc Probe() " +
                type +
                ";",
            "invalid6072",
            false
        )
        Assert.NotEqual(0, code)
        let diagnostics = Regex
            .Matches(output, `\((\d+,\d+,\d+,\d+)\): error (GS\d+):`)
            .Select((m Match) -> m.Groups[2].Value + "@" + m.Groups[1].Value)
            .ToArray()
        Assert.Equal([]string{id + "@3,1,3," + (annotation.Length + 1).ToString()}, diagnostics)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "invalid6072.dll")))
    }

    shared {
        private func AssertMarshal(md MetadataReader, row Parameter, descriptor[]uint8) {
            Assert.True((row.Attributes & ParameterAttributes.HasFieldMarshal) != 0)
            Assert.False(row.GetMarshallingDescriptor().IsNil)
            Assert.Equal(descriptor, md.GetBlobBytes(row.GetMarshallingDescriptor()))
            Assert.DoesNotContain(
                row.GetCustomAttributes().Select(md.GetCustomAttribute),
                (a CustomAttribute) -> {
                    if a.Constructor.Kind != HandleKind.MemberReference {
                        return false
                    }
                    let constructor = md.GetMemberReference(MemberReferenceHandle(a.Constructor))
                    return constructor.Parent.Kind == HandleKind.TypeReference && md.GetString(
                        md.GetTypeReference(TypeReferenceHandle(constructor.Parent)).Name
                    ) == "MarshalAsAttribute"
                }
            )
        }
    }
}
