import NuGet.Packaging
import System
import System.Threading

if args.Length != 1 {
    return 2
}

using let reader = PackageArchiveReader(args[0])
Console.Write(reader.GetContentHash(CancellationToken.None))
return 0
