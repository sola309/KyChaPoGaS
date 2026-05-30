from sqlmodel import SQLModel, create_engine, Session
from pathlib import Path

DB_PATH = Path(__file__).parent.parent.parent / "data" / "kychapogas.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)


def create_db_and_tables() -> None:
    SQLModel.metadata.create_all(engine)


def get_session():
    with Session(engine) as session:
        yield session
