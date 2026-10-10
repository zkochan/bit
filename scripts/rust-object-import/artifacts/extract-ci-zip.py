"""Extract only the three flat CI release files, with bounded decompression and no links."""
import pathlib
import stat
import sys
import zipfile

archive, destination, target, revision = sys.argv[1:]
root = pathlib.Path(destination)
prefix = f"bit-object-import-0.1.0-{target}-{revision[:12]}.tar.gz"
expected = {prefix, prefix + '.sha256', prefix + '.manifest.json'}
with zipfile.ZipFile(archive) as source:
    entries = source.infolist()
    assert len(entries) == 3 and {entry.filename for entry in entries} == expected, 'unexpected CI ZIP members'
    assert sum(entry.file_size for entry in entries) <= 80 * 1024 * 1024, 'expanded artifact too large'
    for entry in entries:
        mode = entry.external_attr >> 16
        assert not entry.is_dir() and not stat.S_ISLNK(mode), 'invalid CI ZIP member type'
        assert not mode or stat.S_IFMT(mode) in (0, stat.S_IFREG), 'special CI ZIP member'
        limit = 80 * 1024 * 1024 if entry.filename == prefix else 65536
        assert 0 < entry.file_size <= limit and not entry.flag_bits & 1, 'invalid CI ZIP bounds'
        with source.open(entry) as stream:
            data = stream.read(limit + 1)
        assert len(data) == entry.file_size and len(data) <= limit, 'invalid decompressed length'
        with (root / entry.filename).open('xb') as output:
            output.write(data)
