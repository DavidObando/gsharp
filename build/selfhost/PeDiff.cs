// Issue #4631 (C3 diagnosis): explains where two builds of the same assembly
// differ: metadata table row counts, heap sizes, and per-method IL keyed by
// declaring type + name + signature blob.
//
// usage: dotnet run build/selfhost/PeDiff.cs -- <left.dll> <right.dll> [max-methods]
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Security.Cryptography;

if (args.Length < 2)
{
    Console.Error.WriteLine("usage: PeDiff <left.dll> <right.dll> [max]");
    return 2;
}

int max = args.Length > 2 ? int.Parse(args[2]) : 40;
using var leftPe = new PEReader(File.OpenRead(args[0]));
using var rightPe = new PEReader(File.OpenRead(args[1]));
MetadataReader left = leftPe.GetMetadataReader();
MetadataReader right = rightPe.GetMetadataReader();

foreach (TableIndex table in Enum.GetValues<TableIndex>())
{
    int l = left.GetTableRowCount(table), r = right.GetTableRowCount(table);
    if (l != r)
    {
        Console.WriteLine($"table {table}: {l} vs {r}");
    }
}

foreach (HeapIndex heap in Enum.GetValues<HeapIndex>())
{
    int l = left.GetHeapSize(heap), r = right.GetHeapSize(heap);
    Console.WriteLine($"heap {heap}: {l} vs {r}{(l == r ? "" : "  <-- differs")}");
}

Dictionary<string, (string Hash, int Size)> Methods(PEReader pe, MetadataReader md)
{
    var result = new Dictionary<string, (string, int)>();
    foreach (MethodDefinitionHandle handle in md.MethodDefinitions)
    {
        MethodDefinition method = md.GetMethodDefinition(handle);
        TypeDefinition type = md.GetTypeDefinition(method.GetDeclaringType());
        string ns = md.GetString(type.Namespace);
        string key = $"{ns}.{md.GetString(type.Name)}::{md.GetString(method.Name)}#{Convert.ToHexString(md.GetBlobBytes(method.Signature))}";
        int n = 0;
        while (result.ContainsKey(key + (n == 0 ? "" : "~" + n))) n++;
        key += n == 0 ? "" : "~" + n;
        byte[] il = method.RelativeVirtualAddress == 0 ? [] : pe.GetMethodBody(method.RelativeVirtualAddress).GetILBytes() ?? [];
        result[key] = (Convert.ToHexString(SHA256.HashData(il))[..16], il.Length);
    }

    return result;
}

var lm = Methods(leftPe, left);
var rm = Methods(rightPe, right);
int onlyLeft = lm.Keys.Except(rm.Keys).Count(), onlyRight = rm.Keys.Except(lm.Keys).Count();
var changed = lm.Where(kv => rm.TryGetValue(kv.Key, out var o) && o.Hash != kv.Value.Hash).ToList();
Console.WriteLine($"methods: {lm.Count} vs {rm.Count}; only-left {onlyLeft}; only-right {onlyRight}; IL differs {changed.Count}");
foreach (var key in lm.Keys.Except(rm.Keys).Take(max)) Console.WriteLine($"  only-left  {key}");
foreach (var key in rm.Keys.Except(lm.Keys).Take(max)) Console.WriteLine($"  only-right {key}");
foreach (var kv in changed.Take(max)) Console.WriteLine($"  IL {kv.Value.Size,6} vs {rm[kv.Key].Size,6}  {kv.Key[..Math.Min(kv.Key.Length, 160)]}");
return 0;
