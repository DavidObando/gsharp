package GSharp.Compiler.Tests

import GSharp.Tests
import System
import System.Collections.Generic
import System.Globalization
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.Metadata.Ecma335
import System.Reflection.PortableExecutable
import System.Security.Cryptography
import System.Text
import System.Text.RegularExpressions

/// Shared fail-closed adapter for the test helper and standalone ILVerify gate.
/// The legacy filter waiver requires opt-in; its skipped-code limitation is tracked in #5115.
internal shared class IlVerifyFalsePositives {
    func OnlyKnown(assemblyPath string, stdout string, allowFilterInFinally bool = false) bool {
        let result = Analyze(assemblyPath, stdout, allowFilterInFinally)
        return result.Complete && result.Accepted.Length != 0 && result.Unexpected.Length == 0
    }

    func Analyze(assemblyPath string, stdout string, allowFilterInFinally bool = false)(
        Complete bool,
        Accepted[]string,
        Unexpected[]string
    ) {
        let errorLines = List[string]()
        let uniqueLines = HashSet[string](StringComparer.Ordinal)
        var reportedCount int32? = nil
        for rawLine in stdout.Replace("\r\n", "\n").Split('\n') {
            let line = rawLine.Trim()
            if line.StartsWith("[IL]: Error", StringComparison.Ordinal) {
                if reportedCount != nil || !uniqueLines.Add(line) {
                    return (false, []string{}, []string{"Malformed or duplicate verifier diagnostic."})
                }
                errorLines.Add(line)
                continue
            }
            let summary = Regex.Match(
                line,
                "^(\\d+) Error\\(s\\) Verifying " + Regex.Escape(Path.GetFullPath(assemblyPath)) + "$"
            )
            if summary.Success {
                var count = 0
                if reportedCount != nil || !int32.TryParse(
                    summary.Groups[1].Value,
                    NumberStyles.None,
                    CultureInfo.InvariantCulture,
                    out count
                ) {
                    return (false, []string{}, []string{"Malformed verifier summary."})
                }
                reportedCount = count
            } else if line.Length != 0 {
                return (false, []string{}, []string{"Unrecognized verifier output: " + line})
            }
        }
        if errorLines.Count == 0 || reportedCount != errorLines.Count {
            return (false, []string{}, []string{"Missing or inconsistent verifier summary."})
        }
        let accepted = List[string]()
        let unexpected = List[string]()
        let filterRule = IlVerifyFilterInFinallyRule.Load(assemblyPath)
        for line in errorLines {
            if ApprovedReturnMatches(assemblyPath, line) {
                accepted.Add(line + " [approved #5244; dotnet/runtime#129030]")
            } else if (allowFilterInFinally && filterRule.Matches(errorCode: nil, line)) ||
                IlVerifyStaticInterfaceRule.Matches(assemblyPath, line) {
                accepted.Add(line)
            } else {
                unexpected.Add(line)
            }
        }
        return (true, accepted.ToArray(), unexpected.ToArray())
    }

    private func ApprovedReturnMatches(assemblyPath string, line string) bool {
        let literal = line == "[IL]: Error [ReturnPtrToStack]: [" + Path.GetFullPath(assemblyPath) +
            " : Utf8Proof.Utf8Candidate::Get()][offset 0x00000014] " +
            "Return type is ByRef, TypedReference, ArgHandle, or ArgIterator."
        let prefix = "[IL]: Error [ReturnPtrToStack]: [" + Path.GetFullPath(assemblyPath) + " : Gsharp.Values."
        let suffix = "] Return type is ByRef, TypedReference, ArgHandle, or ArgIterator."
        if !literal &&
            line != prefix +
            "Slice`1::AsSpan()][offset 0x00000017" +
            suffix &&
            line != prefix +
            "ReadOnlySlice`1::AsSpan()][offset 0x00000010" +
            suffix {
            return false
        }
        try {
            if literal {
                // #5242: this exact witnessed image includes the contiguous payload and hidden zero.
                // Generated product literals are not admitted by this finite research certificate.
                return Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assemblyPath))) ==
                "38B57BE6D6B8ABD3BE70316B48C3ABB6371BCCAF28E6FA6EE6188B005F557BBE"
            }
            return RuntimeReturnProof(
                assemblyPath
            ) == "556C811C449A4F74904C377F2B318C228DD91636A89D88554AC82DD485BD60E9"
        } catch (BadImageFormatException) {
            return false
        } catch (IOException) {
            return false
        } catch (UnauthorizedAccessException) {
            return false
        } catch (ArgumentException) {
            return false
        } catch (InvalidOperationException) {
            return false
        }
    }

    func Report(assemblyPath string, stdout string, allowFilterInFinally bool = false) string {
        let result = Analyze(assemblyPath, stdout, allowFilterInFinally)
        let text = StringBuilder()
            .Append("ILVerify policy: complete=")
            .Append(result.Complete)
            .Append("; accepted=")
            .Append(result.Accepted.Length)
            .Append("; unexpected=")
            .Append(result.Unexpected.Length)
            .AppendLine()
        for line in result.Accepted {
            text.Append("ACCEPTED: ").AppendLine(line)
        }
        for line in result.Unexpected {
            text.Append("UNEXPECTED: ").AppendLine(line)
        }
        return text.ToString()
    }

    // This finite certificate binds signatures, nominal references, and the complete audited array-owner closure.
    // Metadata or body changes require renewed proof; a by-value ref-like signature alone never grants admission.
    internal func RuntimeReturnProof(assemblyPath string) string {
        using let image = File.OpenRead(assemblyPath)
        using let pe = PEReader(image)
        let md = pe.GetMetadataReader()
        using let data = MemoryStream()
        using let writer = BinaryWriter(data)
        let assembly = md.GetAssemblyDefinition()
        writer.Write(md.GetString(assembly.Name))
        writer.Write(assembly.Version.ToString())
        writer.Write(md.GetString(assembly.Culture))
        writer.Write(int32(assembly.Flags))
        WriteBlob(writer, md, assembly.PublicKey)
        writer.Write(md.AssemblyReferences.Count)
        for handle in md.AssemblyReferences {
            let row = md.GetAssemblyReference(handle)
            writer.Write(md.GetString(row.Name))
            writer.Write(row.Version.ToString())
            writer.Write(md.GetString(row.Culture))
            writer.Write(int32(row.Flags))
            WriteBlob(writer, md, row.PublicKeyOrToken)
        }
        writer.Write(md.TypeReferences.Count)
        for handle in md.TypeReferences {
            let row = md.GetTypeReference(handle)
            writer.Write(MetadataTokens.GetToken(row.ResolutionScope))
            writer.Write(md.GetString(row.Namespace))
            writer.Write(md.GetString(row.Name))
        }
        writer.Write(md.TypeDefinitions.Count)
        for handle in md.TypeDefinitions {
            let row = md.GetTypeDefinition(handle)
            writer.Write(md.GetString(row.Namespace))
            writer.Write(md.GetString(row.Name))
            writer.Write(int32(row.Attributes))
            writer.Write(MetadataTokens.GetToken(row.BaseType))
            writer.Write(MetadataTokens.GetToken(row.GetDeclaringType()))
            writer.Write(row.GetGenericParameters().Count)
            let layout = row.GetLayout()
            writer.Write(layout.Size)
            writer.Write(layout.PackingSize)
        }
        writer.Write(md.FieldDefinitions.Count)
        for handle in md.FieldDefinitions {
            let row = md.GetFieldDefinition(handle)
            writer.Write(MetadataTokens.GetToken(row.GetDeclaringType()))
            writer.Write(md.GetString(row.Name))
            writer.Write(int32(row.Attributes))
            writer.Write(row.GetOffset())
            WriteBlob(writer, md, row.Signature)
        }
        var closureCount = 0
        writer.Write(md.MethodDefinitions.Count)
        for handle in md.MethodDefinitions {
            let row = md.GetMethodDefinition(handle)
            let typeName = IlVerifyFilterInFinallyRule.GetTypeName(md, row.GetDeclaringType())
            let name = md.GetString(row.Name)
            writer.Write(typeName)
            writer.Write(name)
            writer.Write(int32(row.Attributes))
            writer.Write(int32(row.ImplAttributes))
            WriteBlob(writer, md, row.Signature)
            if (typeName == "Gsharp.Values.Slice`1" && (name == "get_Owner" || name == "AsSpan")) ||
                (typeName == "Gsharp.Values.ReadOnlySlice`1" && name == "AsSpan") {
                closureCount++
                let body = pe.GetMethodBody(row.RelativeVirtualAddress)
                writer.Write(body.MaxStack)
                writer.Write(body.LocalVariablesInitialized)
                writer.Write(body.ExceptionRegions.Length)
                WriteBlob(
                    writer,
                    md,
                    if body.LocalSignature.IsNil {
                        default(BlobHandle)
                    } else {
                        md.GetStandaloneSignature(body.LocalSignature).Signature
                    }
                )
                let il = body.GetILBytes() ?? Array.Empty[uint8]()
                writer.Write(il.Length)
                writer.Write(il)
            }
        }
        if closureCount != 3 {
            throw BadImageFormatException("The approved runtime return closure must contain exactly three methods.")
        }
        writer.Write(md.MemberReferences.Count)
        for handle in md.MemberReferences {
            let row = md.GetMemberReference(handle)
            writer.Write(MetadataTokens.GetToken(row.Parent))
            writer.Write(md.GetString(row.Name))
            WriteBlob(writer, md, row.Signature)
        }
        writer.Write(md.GetTableRowCount(TableIndex.TypeSpec))
        for var i = 1; i <= md.GetTableRowCount(TableIndex.TypeSpec); i++ {
            WriteBlob(writer, md, md.GetTypeSpecification(MetadataTokens.TypeSpecificationHandle(i)).Signature)
        }
        writer.Write(md.GetTableRowCount(TableIndex.MethodSpec))
        for var i = 1; i <= md.GetTableRowCount(TableIndex.MethodSpec); i++ {
            let row = md.GetMethodSpecification(MetadataTokens.MethodSpecificationHandle(i))
            writer.Write(MetadataTokens.GetToken(row.Method))
            WriteBlob(writer, md, row.Signature)
        }
        writer.Flush()
        return Convert.ToHexString(SHA256.HashData(data.ToArray()))
    }

    private func WriteBlob(writer BinaryWriter, md MetadataReader, handle BlobHandle) {
        let bytes = md.GetBlobBytes(handle)
        writer.Write(bytes.Length)
        writer.Write(bytes)
    }
}
