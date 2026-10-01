package fixture

import (
	"io/fs"
	"reflect"
	"sort"
	"testing"
)

func TestEmbeddedFiles(t *testing.T) {
	assertFiles := func(name string, filesystem fs.FS, want []string) {
		t.Helper()
		var got []string
		if err := fs.WalkDir(filesystem, ".", func(path string, entry fs.DirEntry, err error) error {
			if err == nil && !entry.IsDir() {
				got = append(got, path)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
		sort.Strings(got)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %v, want %v", name, got, want)
		}
	}
	assertFiles("regular", regularAssets, []string{
		"assets/.hidden.txt", "assets/_hidden.txt", "assets/sub/nested.txt", "assets/visible.txt",
	})
	assertFiles("all", allAssets, []string{
		"assets/.hidden.txt", "assets/_hidden.txt", "assets/sub/.nestedhidden.txt",
		"assets/sub/nested.txt", "assets/visible.txt",
	})
	assertFiles("directory", directoryAssets, []string{"assets/sub/nested.txt"})
}
